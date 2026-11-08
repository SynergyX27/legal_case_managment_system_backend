import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

test("Stripe checkout authorization, idempotency and signed payment confirmation", async () => {
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await socket.start();
  const port = socket.getServerConn().split(":").at(-1);
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET: "payments-integration-secret-at-least-32-characters",
    APP_ENCRYPTION_KEY: "b".repeat(64),
    APP_ORIGIN: "http://localhost:8080",
    DROPBOX_REDIRECT_URI:
      "http://localhost:8080/api/integrations/dropbox/callback",
    STRIPE_SECRET_KEY: "sk_test_local_contract_test_only",
    STRIPE_WEBHOOK_SECRET: "whsec_local_contract_test_only",
  });
  const { pool } = await import("../src/config/database.js");
  const { migrate } = await import("../scripts/migrate.js");
  const { createApp } = await import("../src/app.js");
  const { createUserRecord } =
    await import("../src/controllers/auth.controller.js");
  const { stripeClient } = await import("../src/services/payments.service.js");
  let server;
  const stripe = stripeClient(),
    sessions = new Map(),
    keys = new Map();
  const conflictingKeys = new Set();
  let failListing = false;
  let failAfterCreate = false;
  let failBeforeCreate = false;
  const originalCreate = stripe.checkout.sessions.create,
    originalRetrieve = stripe.checkout.sessions.retrieve,
    originalList = stripe.checkout.sessions.list;
  stripe.checkout.sessions.create = async (parameters, options) => {
    if (conflictingKeys.has(options.idempotencyKey))
      throw Object.assign(
        new Error("Key parameters differ from the cached request"),
        { type: "StripeIdempotencyError", rawType: "idempotency_error" },
      );
    assert(
      !Object.hasOwn(parameters, "payment_method_types"),
      "Removed Stripe parameter must never be sent",
    );
    if (failBeforeCreate) {
      failBeforeCreate = false;
      throw Object.assign(
        new Error("simulated failure before provider processing"),
        { type: "StripeConnectionError" },
      );
    }
    let id = keys.get(options.idempotencyKey);
    if (!id) {
      if (parameters.expires_at <= Math.floor(Date.now() / 1000) + 1800) {
        throw Object.assign(
          new Error(
            "expires_at must be between 30 minutes and 24 hours after Checkout Session creation",
          ),
          { type: "StripeInvalidRequestError" },
        );
      }
      id = "cs_test_" + randomUUID();
      keys.set(options.idempotencyKey, id);
      sessions.set(id, {
        id,
        mode: "payment",
        livemode: false,
        metadata: parameters.metadata,
        client_reference_id: parameters.client_reference_id,
        amount_total: parameters.line_items[0].price_data.unit_amount,
        currency: "usd",
        status: "open",
        payment_status: "unpaid",
        url: `https://checkout.stripe.com/c/pay/${id}`,
        payment_intent: "pi_test_" + randomUUID(),
      });
    }
    if (failAfterCreate) {
      failAfterCreate = false;
      throw Object.assign(new Error("simulated dropped response"), {
        type: "StripeConnectionError",
      });
    }
    return structuredClone(sessions.get(id));
  };
  stripe.checkout.sessions.retrieve = async (id) => {
    assert(sessions.has(id));
    return structuredClone(sessions.get(id));
  };
  stripe.checkout.sessions.list = function () {
    return (async function* () {
      if (failListing)
        throw Object.assign(new Error("temporary list failure"), {
          type: "StripeConnectionError",
        });
      for (const session of sessions.values()) yield structuredClone(session);
    })();
  };
  try {
    await migrate();
    await migrate();
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const root = `http://127.0.0.1:${server.address().port}/api`;
    class Client {
      cookie = "";
      csrf = "";
      async request(path, method = "GET", body) {
        const response = await fetch(root + path, {
          method,
          headers: {
            Cookie: this.cookie,
            Origin: "http://localhost:8080",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const cookie = response.headers.get("set-cookie");
        if (cookie) this.cookie = cookie.split(";")[0];
        const data = await response.json();
        if (data.csrfToken) this.csrf = data.csrfToken;
        return { status: response.status, data };
      }
      async login(username) {
        await this.request("/auth/session");
        assert.equal(
          (
            await this.request("/auth/login", "POST", {
              identity: username,
              password: "Payment-test-password-123",
            })
          ).status,
          200,
        );
      }
    }
    const ownerRecord = await createUserRecord(
      {
        name: "Owner",
        email: "owner@payments.invalid",
        username: "owner",
        password: "Payment-test-password-123",
        role: "owner",
      },
      { id: null, role: "owner" },
    );
    const customerRecord = await createUserRecord(
      {
        name: "Customer",
        email: "customer@payments.invalid",
        username: "customer",
        password: "Payment-test-password-123",
        role: "customer",
      },
      ownerRecord,
    );
    await createUserRecord(
      {
        name: "Other customer",
        email: "other@payments.invalid",
        username: "other",
        password: "Payment-test-password-123",
        role: "customer",
      },
      ownerRecord,
    );
    const owner = new Client(),
      customer = new Client(),
      other = new Client();
    await owner.login("owner");
    await customer.login("customer");
    await other.login("other");
    const managerRecord = await createUserRecord(
      {
        name: "Payment manager",
        email: "manager@payments.invalid",
        username: "manager",
        password: "Payment-test-password-123",
        role: "manager",
      },
      ownerRecord,
    );
    const staffRecord = await createUserRecord(
      {
        name: "Payment staff",
        email: "staff@payments.invalid",
        username: "staff",
        password: "Payment-test-password-123",
        role: "staff",
        managerId: managerRecord.id,
      },
      ownerRecord,
    );
    const caseId = randomUUID();
    assert.equal(
      (
        await owner.request(`/cases/${caseId}`, "PUT", {
          id: caseId,
          number: "PAY-001",
          title: "Payment case",
          staffId: staffRecord.id,
          managerId: managerRecord.id,
          clientId: customerRecord.client_id,
          residentName: "Tenant",
          type: "Notice",
          status: "Active",
          priority: "Medium",
        })
      ).status,
      200,
    );
    async function invoice(status = "Sent", price = 100) {
      const id = randomUUID();
      assert.equal(
        (
          await owner.request(`/invoices/${id}`, "PUT", {
            id,
            caseId,
            clientId: customerRecord.client_id,
            date: "2026-11-08",
            dueDate: "2026-12-08",
            lines: [{ description: "Case service", qty: 2, price }],
            taxRate: 10,
            status,
          })
        ).status,
        200,
      );
      return id;
    }
    const id = await invoice();
    const draft = await invoice("Draft");
    assert.equal(
      (await other.request(`/invoices/${id}/checkout`, "POST")).status,
      404,
    );
    assert.equal(
      (await owner.request(`/invoices/${id}/checkout`, "POST")).status,
      403,
    );
    assert.equal(
      (await customer.request(`/invoices/${draft}/checkout`, "POST")).status,
      404,
    );
    assert.equal(
      (await customer.request("/payments/config")).data.enabled,
      true,
    );
    const first = await customer.request(`/invoices/${id}/checkout`, "POST", {
      amount: 1,
      currency: "gbp",
    });
    assert.equal(first.status, 200, JSON.stringify(first));
    const second = await customer.request(`/invoices/${id}/checkout`, "POST");
    assert.equal(first.data.url, second.data.url);
    assert.equal(sessions.size, 1);
    const session = [...sessions.values()][0];
    assert.equal(session.amount_total, 22000);
    assert.equal(session.currency, "usd");
    let current = (await owner.request("/workspace")).data.invoices.find(
      (i) => i.id === id,
    );
    assert.equal(current.status, "Sent");
    assert.equal(
      (
        await owner.request(`/invoices/${id}`, "PUT", {
          ...current,
          status: "Paid",
        })
      ).status,
      409,
    );
    async function webhook(
      object,
      {
        id = "evt_" + randomUUID(),
        signature = true,
        type = "checkout.session.completed",
      } = {},
    ) {
      const body = JSON.stringify({
        id,
        object: "event",
        type,
        data: { object },
      });
      const header = signature
        ? stripe.webhooks.generateTestHeaderString({
            payload: body,
            secret: process.env.STRIPE_WEBHOOK_SECRET,
          })
        : "invalid";
      const r = await fetch(root + "/payments/stripe/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": header,
        },
        body,
      });
      return { status: r.status, data: await r.json() };
    }
    const eventId = "evt_payment_confirmed";
    session.status = "complete";
    session.payment_status = "paid";
    assert.equal((await webhook(session, { signature: false })).status, 400);
    assert.equal(
      (await owner.request("/workspace")).data.invoices.find((i) => i.id === id)
        .status,
      "Sent",
    );
    assert.equal((await webhook({ ...session, amount_total: 1 })).status, 409);
    assert.equal(
      (await owner.request("/workspace")).data.invoices.find((i) => i.id === id)
        .status,
      "Sent",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legalflow.email_outbox WHERE event_key=$1",
          [`invoice.paid:${id}`],
        )
      ).rows[0].n,
      0,
      "Unverified and mismatched payments cannot queue receipts",
    );
    assert.equal((await webhook(session, { id: eventId })).status, 200);
    assert.equal((await webhook(session, { id: eventId })).status, 200);
    assert.equal((await webhook(session)).status, 200);
    current = (await customer.request("/workspace")).data.invoices.find(
      (i) => i.id === id,
    );
    assert.equal(current.status, "Paid");
    assert.equal(current.paymentMethod, "stripe");
    const receiptRows = (
      await pool.query(
        "SELECT to_email FROM legalflow.email_outbox WHERE event_key=$1",
        [`invoice.paid:${id}`],
      )
    ).rows;
    assert.deepEqual(
      receiptRows.map((r) => r.to_email).sort(),
      [
        "customer@payments.invalid",
        "owner@payments.invalid",
        "manager@payments.invalid",
        "staff@payments.invalid",
      ].sort(),
      "Repeated webhooks queue one receipt for each intended recipient",
    );

    assert(current.paidAt);
    assert.equal(
      (await customer.request(`/invoices/${id}/checkout`, "POST")).status,
      409,
    );
    assert.equal(
      (
        await owner.request(`/invoices/${id}`, "PUT", {
          ...current,
          status: "Sent",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legalflow.activities WHERE text LIKE '%paid online%'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legalflow.invoice_payments WHERE status='paid'",
        )
      ).rows[0].n,
      1,
    );
    // A completed session with an unpaid status must never mark the invoice paid.
    const pending = await invoice();
    await customer.request(`/invoices/${pending}/checkout`, "POST");
    const pendingSession = [...sessions.values()].find(
      (s) => s.metadata.invoiceId === pending,
    );
    pendingSession.status = "complete";
    assert.equal((await webhook(pendingSession)).status, 200);
    assert.equal(
      (await customer.request(`/invoices/${pending}/payment-status`, "POST"))
        .data.status,
      "Sent",
    );
    // Expired sessions release the attempt and allow a fresh checkout.
    const expired = await invoice();
    await customer.request(`/invoices/${expired}/checkout`, "POST");
    const expiredSession = [...sessions.values()].find(
      (s) => s.metadata.invoiceId === expired,
    );
    expiredSession.status = "expired";
    await webhook(expiredSession, { type: "checkout.session.expired" });
    const retry = await customer.request(
      `/invoices/${expired}/checkout`,
      "POST",
    );
    assert.equal(retry.status, 200);
    assert.notEqual(retry.data.url, expiredSession.url);
    // Lost provider responses reuse exactly the same idempotency key and Checkout session.
    const interrupted = await invoice();
    failAfterCreate = true;
    assert.equal(
      (await customer.request(`/invoices/${interrupted}/checkout`, "POST"))
        .status,
      502,
    );
    assert.equal(
      (await customer.request(`/invoices/${interrupted}/checkout`, "POST"))
        .status,
      200,
    );
    assert.equal(
      [...sessions.values()].filter((s) => s.metadata.invoiceId === interrupted)
        .length,
      1,
    );
    // Server-side status checking also recovers a paid session if the browser returns before the webhook.
    const recovered = [...sessions.values()].find(
      (s) => s.metadata.invoiceId === interrupted,
    );
    recovered.status = "complete";
    recovered.payment_status = "paid";
    assert.equal(
      (
        await customer.request(
          `/invoices/${interrupted}/payment-status`,
          "POST",
        )
      ).data.status,
      "Paid",
    );
    assert.equal(
      (await other.request(`/invoices/${interrupted}/payment-status`, "POST"))
        .status,
      404,
    );
    // Legacy attempts can carry an expiry at or below Stripe's minimum. Validation
    // errors do not create a session; reset that reservation without touching paid data.
    const legacy = await invoice();
    failBeforeCreate = true;
    assert.equal(
      (await customer.request(`/invoices/${legacy}/checkout`, "POST")).status,
      502,
    );
    const legacyAttempt = (
      await pool.query(
        "SELECT * FROM legalflow.invoice_payments WHERE invoice_id=$1",
        [legacy],
      )
    ).rows[0];
    assert(
      legacyAttempt.checkout_parameters.expires_at >=
        Math.floor(Date.now() / 1000) + 2600,
    );
    await pool.query(
      "UPDATE legalflow.invoice_payments SET checkout_parameters=jsonb_set(checkout_parameters,'{expires_at}',$2::jsonb) WHERE id=$1",
      [legacyAttempt.id, JSON.stringify(Math.floor(Date.now() / 1000) + 1790)],
    );
    const legacyReply = await customer.request(
      `/invoices/${legacy}/checkout`,
      "POST",
    );
    assert.equal(legacyReply.status, 409);
    assert.match(legacyReply.data.error, /expired/);
    assert.equal(
      (await customer.request(`/invoices/${legacy}/checkout`, "POST")).status,
      200,
    );
    assert.equal(
      [...sessions.values()].filter((s) => s.metadata.invoiceId === legacy)
        .length,
      1,
    );
    const legacyMethods = await invoice();
    failBeforeCreate = true;
    assert.equal(
      (await customer.request(`/invoices/${legacyMethods}/checkout`, "POST"))
        .status,
      502,
    );
    const methodsAttempt = (
      await pool.query(
        "SELECT * FROM legalflow.invoice_payments WHERE invoice_id=$1",
        [legacyMethods],
      )
    ).rows[0];
    await pool.query(
      "UPDATE legalflow.invoice_payments SET checkout_parameters=checkout_parameters||$2::jsonb WHERE id=$1",
      [methodsAttempt.id, JSON.stringify({ payment_method_types: ["card"] })],
    );
    assert.equal(
      (await customer.request(`/invoices/${legacyMethods}/checkout`, "POST"))
        .status,
      200,
    );
    assert(keys.has(`legalflow-checkout-${methodsAttempt.id}`));
    assert(
      !Object.hasOwn(
        (
          await pool.query(
            "SELECT checkout_parameters FROM legalflow.invoice_payments WHERE id=$1",
            [methodsAttempt.id],
          )
        ).rows[0].checkout_parameters,
        "payment_method_types",
      ),
    );
    // Dashboard-enabled delayed methods remain unpaid until confirmed; a final
    // failure releases checkout, and an out-of-order failure cannot undo Paid.
    await webhook(pendingSession, {
      type: "checkout.session.async_payment_failed",
    });
    assert.equal(
      (await customer.request(`/invoices/${pending}/checkout`, "POST")).status,
      200,
    );
    await webhook(session, { type: "checkout.session.async_payment_failed" });
    assert.equal(
      (await customer.request(`/invoices/${id}/payment-status`, "POST")).data
        .status,
      "Paid",
    );
    async function breakLegacyKey(id, providerSession = false) {
      if (providerSession) failAfterCreate = true;
      else failBeforeCreate = true;
      assert.equal(
        (await customer.request(`/invoices/${id}/checkout`, "POST")).status,
        502,
      );
      const attempt = (
        await pool.query(
          "SELECT * FROM legalflow.invoice_payments WHERE invoice_id=$1",
          [id],
        )
      ).rows[0];
      conflictingKeys.add(`legalflow-checkout-${attempt.id}`);
      await pool.query(
        "UPDATE legalflow.invoice_payments SET created_at=now()-interval '2 minutes' WHERE id=$1",
        [attempt.id],
      );
      return attempt;
    }
    // Old failed key with no provider session: reconcile, then issue just one new attempt.
    const staleKey = await invoice();
    await breakLegacyKey(staleKey);
    const staleResults = await Promise.all([
      customer.request(`/invoices/${staleKey}/checkout`, "POST"),
      customer.request(`/invoices/${staleKey}/checkout`, "POST"),
    ]);
    assert(staleResults.every((r) => r.status === 200));
    assert.equal(staleResults[0].data.url, staleResults[1].data.url);
    assert.equal(
      [...sessions.values()].filter((s) => s.metadata.invoiceId === staleKey)
        .length,
      1,
    );
    // Existing open provider session: recover it without creating a second checkout.
    const openKey = await invoice();
    await breakLegacyKey(openKey, true);
    const openSession = [...sessions.values()].find(
      (s) => s.metadata.invoiceId === openKey,
    );
    const openRecovery = await customer.request(
      `/invoices/${openKey}/checkout`,
      "POST",
    );
    assert.equal(openRecovery.status, 200);
    assert.equal(openRecovery.data.url, openSession.url);
    assert.equal(
      [...sessions.values()].filter((s) => s.metadata.invoiceId === openKey)
        .length,
      1,
    );
    // Existing paid provider session: update Paid instead of issuing a new checkout.
    const paidKey = await invoice();
    await breakLegacyKey(paidKey, true);
    const alreadyPaid = [...sessions.values()].find(
      (s) => s.metadata.invoiceId === paidKey,
    );
    alreadyPaid.status = "complete";
    alreadyPaid.payment_status = "paid";
    const paidRecovery = await customer.request(
      `/invoices/${paidKey}/checkout`,
      "POST",
    );
    assert.equal(paidRecovery.status, 200);
    assert.equal(paidRecovery.data.paid, true);
    assert.equal(
      (await customer.request(`/invoices/${paidKey}/payment-status`, "POST"))
        .data.status,
      "Paid",
    );
    assert.equal(
      [...sessions.values()].filter((s) => s.metadata.invoiceId === paidKey)
        .length,
      1,
    );
    // Provider lookup failures leave the old attempt locked; no unverified replacement.
    const lookupKey = await invoice();
    const lookupAttempt = await breakLegacyKey(lookupKey);
    failListing = true;
    assert.equal(
      (await customer.request(`/invoices/${lookupKey}/checkout`, "POST"))
        .status,
      502,
    );
    failListing = false;
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM legalflow.invoice_payments WHERE id=$1",
          [lookupAttempt.id],
        )
      ).rows[0].status,
      "creating",
    );
    assert.equal(
      [...sessions.values()].filter((s) => s.metadata.invoiceId === lookupKey)
        .length,
      0,
    );
    const agedKey = await invoice();
    const agedAttempt = await breakLegacyKey(agedKey);
    await pool.query(
      "UPDATE legalflow.invoice_payments SET created_at=now()-interval '25 hours' WHERE id=$1",
      [agedAttempt.id],
    );
    assert.equal(
      (await customer.request(`/invoices/${agedKey}/checkout`, "POST")).status,
      200,
    );
    assert.equal(
      [...sessions.values()].filter((s) => s.metadata.invoiceId === agedKey)
        .length,
      1,
    );
    const zero = await invoice("Sent", 0);
    assert.equal(
      (await customer.request(`/invoices/${zero}/checkout`, "POST")).status,
      422,
    );
    console.log(
      "Verified server totals, customer ownership, signed webhooks, duplicate delivery, checkout reuse, unpaid/expired handling and confirmation recovery",
    );
  } finally {
    stripe.checkout.sessions.create = originalCreate;
    stripe.checkout.sessions.retrieve = originalRetrieve;
    stripe.checkout.sessions.list = originalList;
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
