import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { pool, transaction } from "../config/database.js";
import { assert, HttpError } from "../utils/errors.js";
import { accessibleCase } from "../models/case.model.js";
import { activity, audit, notify } from "../models/audit.model.js";

let client;
export function stripeClient() {
  assert(env.STRIPE_SECRET_KEY, 503, "Online payments are not configured");
  return (client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    timeout: 20000,
    maxNetworkRetries: 1,
  }));
}
export const paymentConfiguration = () => ({
  enabled: !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
  currency: "usd",
  testMode: env.STRIPE_SECRET_KEY.startsWith("sk_test_"),
});
export function invoiceAmountCents(invoice) {
  const amount = Math.round(
    invoice.lines.reduce((sum, line) => sum + line.qty * line.price, 0) *
      (1 + invoice.taxRate / 100) *
      100,
  );
  assert(
    Number.isSafeInteger(amount) && amount >= 50 && amount <= 99999999,
    422,
    "Online invoice payments must be between $0.50 and $999,999.99 USD",
  );
  return amount;
}
async function authorizedInvoice(user, id, db = pool, lock = false) {
  if (lock) {
    const before = (
      await db.query("SELECT case_id FROM legalflow.invoices WHERE id=$1", [id])
    ).rows[0];
    assert(before, 404, "Invoice not found");
    await db.query("SELECT id FROM legalflow.cases WHERE id=$1 FOR UPDATE", [
      before.case_id,
    ]);
  }
  const row = (
    await db.query(
      `SELECT * FROM legalflow.invoices WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  assert(row, 404, "Invoice not found");
  await accessibleCase(user, row.case_id, db);
  assert(
    ["owner", "manager"].includes(user.role) ||
      (user.role === "customer" &&
        user.client_id === row.client_id &&
        row.data.status !== "Draft"),
    404,
    "Invoice not found",
  );
  return row;
}
async function reservePayment(user, invoiceId) {
  return transaction(async (db) => {
    const invoice = await authorizedInvoice(user, invoiceId, db, true);
    assert(
      user.role === "customer" && user.client_id === invoice.client_id,
      403,
      "Only the assigned customer can pay this invoice",
    );
    assert(
      ["Sent", "Overdue"].includes(invoice.data.status),
      409,
      "Only unpaid, published invoices can be paid online",
    );
    const old = (
      await db.query(
        "SELECT * FROM legalflow.invoice_payments WHERE invoice_id=$1 AND status IN ('creating','open','processing') FOR UPDATE",
        [invoice.id],
      )
    ).rows[0];
    if (old) return old;
    const id = randomUUID(),
      amount = invoiceAmountCents(invoice.data);
    const parameters = {
      mode: "payment",
      payment_method_types: ["card"],
      client_reference_id: invoice.id,
      customer_email: user.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amount,
            product_data: {
              name: `Invoice ${invoice.number}`,
              description: "Full invoice total, including the invoice tax.",
            },
          },
        },
      ],
      metadata: { invoiceId: invoice.id, paymentId: id },
      payment_intent_data: {
        metadata: { invoiceId: invoice.id, paymentId: id },
      },
      success_url: `${env.APP_ORIGIN}/invoices?payment=success&invoiceId=${encodeURIComponent(invoice.id)}`,
      cancel_url: `${env.APP_ORIGIN}/invoices?payment=cancelled&invoiceId=${encodeURIComponent(invoice.id)}`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    };
    const result = await db.query(
      "INSERT INTO legalflow.invoice_payments(id,invoice_id,user_id,amount_cents,currency,status,checkout_parameters) VALUES($1,$2,$3,$4,'usd','creating',$5) RETURNING *",
      [id, invoice.id, user.id, amount, parameters],
    );
    await audit(db, user, "invoice.checkout-requested", invoice.id);
    return result.rows[0];
  });
}
// Called only with a signature-verified webhook object or a server-to-server Stripe retrieval.
export async function applyStripeSession(session, event = null) {
  return transaction(async (db) => {
    if (event) {
      const inserted = await db.query(
        "INSERT INTO legalflow.stripe_events(id,type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",
        [event.id, event.type],
      );
      if (!inserted.rowCount) return;
    }
    const paymentId = session.metadata?.paymentId,
      invoiceId = session.metadata?.invoiceId;
    if (!paymentId || !invoiceId) return; // Ignore Checkout sessions belonging to other applications.
    const before = (
      await db.query("SELECT case_id FROM legalflow.invoices WHERE id=$1", [
        invoiceId,
      ])
    ).rows[0];
    if (!before) return;
    await db.query("SELECT id FROM legalflow.cases WHERE id=$1 FOR UPDATE", [
      before.case_id,
    ]);
    const invoice = (
      await db.query(
        "SELECT * FROM legalflow.invoices WHERE id=$1 FOR UPDATE",
        [invoiceId],
      )
    ).rows[0];
    if (!invoice) return;
    const payment = (
      await db.query(
        "SELECT * FROM legalflow.invoice_payments WHERE id=$1 AND invoice_id=$2 FOR UPDATE",
        [paymentId, invoiceId],
      )
    ).rows[0];
    if (!payment) return;
    assert(
      session.mode === "payment" &&
        session.client_reference_id === invoiceId &&
        (!payment.stripe_session_id ||
          payment.stripe_session_id === session.id),
      409,
      "Stripe payment reference does not match the invoice",
    );
    assert(
      session.livemode === env.STRIPE_SECRET_KEY.startsWith("sk_live_"),
      409,
      "Stripe payment mode does not match the configured account",
    );
    assert(
      session.amount_total === Number(payment.amount_cents) &&
        session.currency === payment.currency,
      409,
      "Stripe payment total does not match the invoice",
    );
    if (payment.status === "paid") return;
    if (session.payment_status === "paid") {
      assert(
        invoiceAmountCents(invoice.data) === Number(payment.amount_cents) &&
          ["Sent", "Overdue"].includes(invoice.data.status),
        409,
        "Invoice changed before payment was confirmed",
      );
      const intent =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      const paidAt = new Date().toISOString();
      await db.query(
        "UPDATE legalflow.invoice_payments SET status='paid',stripe_session_id=$2,stripe_payment_intent_id=$3,paid_at=$4,updated_at=now() WHERE id=$1",
        [payment.id, session.id, intent || null, paidAt],
      );
      await db.query(
        "UPDATE legalflow.invoices SET data=data||$2::jsonb,updated_at=now() WHERE id=$1",
        [
          invoiceId,
          JSON.stringify({
            status: "Paid",
            paidAt,
            paymentMethod: "stripe",
            stripePaymentId: payment.id,
            stripeSessionId: session.id,
          }),
        ],
      );
      const actor = { id: payment.user_id };
      await activity(
        db,
        actor,
        invoice.case_id,
        `${invoice.number}: paid online with Stripe`,
        "invoice",
      );
      await audit(db, actor, "invoice.paid-online", invoiceId);
      const c = (
        await db.query(
          "SELECT staff_id,manager_id FROM legalflow.cases WHERE id=$1",
          [invoice.case_id],
        )
      ).rows[0];
      const owners = (
        await db.query(
          "SELECT id FROM legalflow.users WHERE role='owner' AND status='Active'",
        )
      ).rows;
      await notify(
        db,
        [payment.user_id, c?.manager_id, ...owners.map((o) => o.id)],
        "invoice",
        `${invoice.number} paid online`,
        "/invoices",
      );
    } else if (session.status === "expired") {
      await db.query(
        "UPDATE legalflow.invoice_payments SET status='expired',stripe_session_id=$2,updated_at=now() WHERE id=$1 AND status<>'paid'",
        [payment.id, session.id],
      );
    } else if (session.status === "complete") {
      await db.query(
        "UPDATE legalflow.invoice_payments SET status='processing',stripe_session_id=$2,updated_at=now() WHERE id=$1 AND status<>'paid'",
        [payment.id, session.id],
      );
    }
  });
}
export async function createCheckout(user, invoiceId) {
  assert(
    paymentConfiguration().enabled,
    503,
    "Online payments are not configured. Ask the owner to finish Stripe setup",
  );
  let payment = await reservePayment(user, invoiceId);
  try {
    if (payment.status === "creating" && !payment.stripe_session_id) {
      // Never retry an unknown session beyond Stripe's idempotency retention window.
      assert(
        Date.now() - new Date(payment.created_at).getTime() < 23 * 3600000,
        409,
        "This checkout needs payment reconciliation. Ask the owner to check it",
      );
      const session = await stripeClient().checkout.sessions.create(
        payment.checkout_parameters,
        { idempotencyKey: `legalflow-checkout-${payment.id}` },
      );
      await pool.query(
        "UPDATE legalflow.invoice_payments SET stripe_session_id=$2,status=CASE WHEN status='creating' THEN 'open' ELSE status END,updated_at=now() WHERE id=$1",
        [payment.id, session.id],
      );
      payment = { ...payment, stripe_session_id: session.id };
    }
    const session = await stripeClient().checkout.sessions.retrieve(
      payment.stripe_session_id,
    );
    await applyStripeSession(session);
    if (session.payment_status === "paid") return { paid: true };
    if (session.status === "expired")
      throw new HttpError(
        409,
        "This checkout expired. Click Pay online again to start a new checkout",
      );
    assert(
      session.status === "open" && session.url,
      409,
      "Your payment is being confirmed. Please wait before trying again",
    );
    const url = new URL(session.url);
    assert(
      url.protocol === "https:" && url.hostname === "checkout.stripe.com",
      502,
      "Stripe returned an invalid checkout URL",
    );
    return { url: session.url };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (
      error.type === "StripeInvalidRequestError" &&
      error.param === "expires_at"
    ) {
      await pool.query(
        "UPDATE legalflow.invoice_payments SET status='expired',updated_at=now() WHERE id=$1 AND status='creating' AND stripe_session_id IS NULL",
        [payment.id],
      );
      throw new HttpError(
        409,
        "This checkout attempt expired before it opened. Click Pay online again",
      );
    }
    console.error(
      JSON.stringify({
        operation: "stripe.checkout",
        invoiceId,
        code: error.code || error.type || "provider_error",
      }),
    );
    throw new HttpError(
      502,
      "Stripe could not open checkout. Please try again; the same payment attempt will be reused",
    );
  }
}
export async function paymentStatus(user, invoiceId) {
  const invoice = await authorizedInvoice(user, invoiceId);
  if (invoice.data.status === "Paid") return { status: "Paid" };
  const p = (
    await pool.query(
      "SELECT * FROM legalflow.invoice_payments WHERE invoice_id=$1 AND status IN ('creating','open','processing') ORDER BY created_at DESC LIMIT 1",
      [invoiceId],
    )
  ).rows[0];
  if (p?.stripe_session_id && paymentConfiguration().enabled) {
    try {
      await applyStripeSession(
        await stripeClient().checkout.sessions.retrieve(p.stripe_session_id),
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "Could not check Stripe payment status. Your invoice will update when confirmation arrives",
      );
    }
  }
  const current = (
    await pool.query("SELECT data FROM legalflow.invoices WHERE id=$1", [
      invoiceId,
    ])
  ).rows[0];
  return { status: current.data.status };
}
export async function processStripeEvent(event) {
  if (
    ![
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.expired",
    ].includes(event.type)
  )
    return;
  await applyStripeSession(event.data.object, event);
}
