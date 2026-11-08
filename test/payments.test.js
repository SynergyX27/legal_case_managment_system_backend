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
  let failAfterCreate = false;
  const originalCreate = stripe.checkout.sessions.create,
    originalRetrieve = stripe.checkout.sessions.retrieve;
  stripe.checkout.sessions.create = async (parameters, options) => {
    let id = keys.get(options.idempotencyKey);
    if (!id) {
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
    const caseId = randomUUID();
    assert.equal(
      (
        await owner.request(`/cases/${caseId}`, "PUT", {
          id: caseId,
          number: "PAY-001",
          title: "Payment case",
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
    assert.equal((await webhook(session, { id: eventId })).status, 200);
    assert.equal((await webhook(session, { id: eventId })).status, 200);
    assert.equal((await webhook(session)).status, 200);
    current = (await customer.request("/workspace")).data.invoices.find(
      (i) => i.id === id,
    );
    assert.equal(current.status, "Paid");
    assert.equal(current.paymentMethod, "stripe");
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
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
