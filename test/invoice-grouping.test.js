import test from "node:test";
import assert from "node:assert/strict";
import {
  invoiceAllocations,
  invoiceTotals,
} from "../src/services/invoice-math.service.js";
test("group discounts and tax allocate exact cents, with legacy totals preserved", () => {
  const i = {
    caseId: "a",
    caseIds: ["a", "b"],
    lines: [
      { caseId: "a", qty: 1, price: 650 },
      { caseId: "b", qty: 1, price: 650 },
    ],
    discount: 200,
    taxRate: 10,
  };
  assert.deepEqual(invoiceTotals(i), {
    base: 130000,
    discount: 20000,
    net: 110000,
    tax: 11000,
    total: 121000,
  });
  assert.deepEqual(invoiceAllocations(i), { a: 60500, b: 60500 });
  for (let n = 1; n < 100; n++) {
    const v = {
      ...i,
      discount: n / 100,
      lines: [
        { caseId: "a", qty: 3, price: 0.01 },
        { caseId: "b", qty: 1, price: 100 },
      ],
    };
    assert.equal(
      Object.values(invoiceAllocations(v)).reduce((a, b) => a + b, 0),
      invoiceTotals(v).total,
    );
  }
  const legacy = {
    caseId: "a",
    lines: [
      { qty: 0.333, price: 1 },
      { qty: 0.333, price: 1 },
    ],
    taxRate: 7,
  };
  assert.equal(invoiceTotals(legacy).total, Math.round(0.666 * 1.07 * 100));
});

test("grouped invoice persistence, isolation, discounts, PDFs and paid balances", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const db = await PGlite.create(),
    socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await socket.start();
  const port = socket.getServerConn().split(":").at(-1);
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET: "group-invoice-integration-secret-at-least-32-characters",
    APP_ENCRYPTION_KEY: "a".repeat(64),
    APP_ORIGIN: "http://localhost:8080",
    STRIPE_SECRET_KEY: "sk_test_local_group_contract",
    STRIPE_WEBHOOK_SECRET: "whsec_local_group_contract",
    DROPBOX_REDIRECT_URI:
      "http://localhost:8080/api/integrations/dropbox/callback",
  });
  const { pool } = await import("../src/config/database.js");
  const { migrate } = await import("../scripts/migrate.js");
  const { createUserRecord } =
    await import("../src/controllers/auth.controller.js");
  const { createApp } = await import("../src/app.js");
  let server;
  try {
    await migrate();
    const create = (username, role, extra = {}) =>
      createUserRecord(
        {
          name: username,
          email: `${username}@test.invalid`,
          username,
          password: "Test-password-12345",
          role,
          ...extra,
        },
        { role: "owner", id: undefined },
      );
    const owner = await create("owner", "owner"),
      customer = await create("customer", "customer"),
      manager = await create("manager", "manager"),
      staff = await create("staff", "staff", { managerId: manager.id });
    await pool.query(
      "INSERT INTO legalflow.workspaces(id,client_id,kind,name) VALUES('territory',$1,'territory','Georgia')",
      [customer.client_id],
    );
    await pool.query(
      "INSERT INTO legalflow.workspaces(id,client_id,parent_id,kind,name) VALUES('community',$1,'territory','community','Demo community')",
      [customer.client_id],
    );
    for (const id of ["a", "b", "c"]) {
      const data = {
        id,
        clientId: customer.client_id,
        number: id,
        propertyType: "APT",
        serviceDate: id === "c" ? "2026-11-27" : "2026-11-26",
        residentName: `Tenant ${id}`,
        residentAddress: "2035 Example Street",
        unit: id,
        community: "Demo community",
        moneyOwed: 1500,
        status: "Pending",
      };
      await pool.query(
        "INSERT INTO legalflow.cases(id,number,client_id,staff_id,manager_id,workspace_id,data) VALUES($1,$1,$2,$3,$4,'community',$5)",
        [id, customer.client_id, staff.id, manager.id, data],
      );
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const root = `http://127.0.0.1:${server.address().port}/api`;
    async function login(identity) {
      let cookie = "",
        csrf = "";
      async function req(path, method = "GET", body) {
        const r = await fetch(root + path, {
          method,
          headers: {
            Cookie: cookie,
            Origin: "http://localhost:8080",
            "X-CSRF-Token": csrf,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        cookie = r.headers.get("set-cookie")?.split(";")[0] || cookie;
        const data = r.headers.get("content-type")?.includes("pdf")
          ? Buffer.from(await r.arrayBuffer())
          : await r.json();
        if (data.csrfToken) csrf = data.csrfToken;
        return { status: r.status, data };
      }
      await req("/auth/session");
      assert.equal(
        (
          await req("/auth/login", "POST", {
            identity,
            password: "Test-password-12345",
          })
        ).status,
        200,
      );
      return req;
    }
    const o = await login("owner"),
      u = await login("customer");
    const i = {
      caseId: "a",
      caseIds: ["a", "b"],
      clientId: customer.client_id,
      date: "2026-11-26",
      dueDate: "2026-12-26",
      lines: [
        {
          caseId: "a",
          description: "Setout A",
          qty: 1,
          price: 650,
          serviceOutcome: "Cleared",
        },
        {
          caseId: "b",
          description: "Setout B",
          qty: 1,
          price: 650,
          serviceOutcome: "Vacant",
        },
      ],
      taxRate: 0,
      discount: 200,
      status: "Sent",
    };
    assert.equal((await o("/invoices/group", "PUT", i)).status, 200);
    let w = (await o("/workspace")).data;
    let inv = w.invoices.find((x) => x.id === "group");
    assert.equal(inv.template, "T2B");
    assert.match(inv.number, /2035-X26-11-26/);
    assert.equal(invoiceTotals(inv).total, 110000);
    assert.equal(
      (
        await o("/invoices/bad", "PUT", {
          ...i,
          caseIds: ["a", "c"],
          lines: i.lines.map((l) => ({
            ...l,
            caseId: l.caseId === "b" ? "c" : "a",
          })),
        })
      ).status,
      422,
    );
    assert.equal(
      (await o("/invoices/bad-discount", "PUT", { ...i, discount: 1301 }))
        .status,
      422,
    );
    const pdf = await u("/invoices/group/pdf");
    assert.equal(pdf.status, 200);
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    assert.equal(
      (pdf.data.toString("latin1").match(/\/Type \/Page\b/g) || []).length,
      1,
    );
    assert.equal((await u("/cases/b/invoices/pdf")).status, 200);
    const { env } = await import("../src/config/env.js");
    env.SMTP_ENABLED = true;
    assert.equal(
      (await o("/invoices/group/email", "POST", { mode: "invoice" })).status,
      200,
    );
    assert.equal(
      (await o("/invoices/group/email", "POST", { mode: "payment" })).status,
      200,
    );
    assert.equal(
      (
        await o("/invoices/group/email", "POST", {
          mode: "message",
          message: "Please review your invoice.",
        })
      ).status,
      200,
    );
    assert.equal(
      (await u("/invoices/group/email", "POST", { mode: "invoice" })).status,
      403,
    );
    const mail = (
      await pool.query(
        "SELECT attachments FROM legalflow.email_outbox WHERE event_key LIKE 'invoice.delivery:%' AND jsonb_array_length(attachments)>0",
      )
    ).rows[0];
    assert.equal(
      Buffer.from(mail.attachments[0].content, "base64")
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
    await pool.query(
      "UPDATE legalflow.users SET customer_access='community' WHERE id=$1",
      [customer.id],
    );
    assert.equal((await u("/workspace")).data.invoices.length, 0);
    assert.equal((await u("/invoices/group/pdf")).status, 404);
    assert.equal(
      (await o("/invoices/group/email", "POST", { mode: "payment" })).status,
      422,
    );
    await pool.query(
      "UPDATE legalflow.users SET customer_access='all' WHERE id=$1",
      [customer.id],
    );
    assert.equal(
      (await o("/invoices/group", "PUT", { ...inv, status: "Paid" })).status,
      200,
    );
    w = (await o("/workspace")).data;
    assert.equal(w.cases.find((c) => c.id === "a").paidInvoiceTotal, 550);
    assert.equal(w.cases.find((c) => c.id === "b").paidInvoiceTotal, 550);
    assert.equal(
      (await o("/cases/b", "DELETE", { deleteEmailConversations: true }))
        .status,
      409,
    );
    assert.equal(
      (await o("/invoices/online-group", "PUT", { ...i, discount: 100 }))
        .status,
      200,
    );
    const { stripeClient, createCheckout, applyStripeSession } =
      await import("../src/services/payments.service.js");
    const stripe = stripeClient();
    let session,
      creates = 0;
    stripe.checkout.sessions.create = async (p) => {
      creates++;
      session = {
        ...p,
        id: "cs_group",
        url: "https://checkout.stripe.com/c/pay/cs_group",
        livemode: false,
        amount_total: p.line_items[0].price_data.unit_amount,
        currency: "usd",
        status: "open",
        payment_status: "unpaid",
      };
      return session;
    };
    stripe.checkout.sessions.retrieve = async () => session;
    await createCheckout(customer, "online-group");
    await createCheckout(customer, "online-group");
    assert.equal(creates, 1);
    assert.equal(session.amount_total, 120000);
    session = {
      ...session,
      status: "complete",
      payment_status: "paid",
      payment_intent: "pi_group",
    };
    await applyStripeSession(session);
    await applyStripeSession(session);
    w = (await o("/workspace")).data;
    assert.equal(w.cases.find((c) => c.id === "a").paidInvoiceTotal, 1150);
    assert.equal(w.cases.find((c) => c.id === "b").paidInvoiceTotal, 1150);
    const before = (await o("/workspace")).data.invoices.find(
      (x) => x.id === "group",
    );
    assert.equal((await o("/invoices/group", "PUT", before)).status, 409);
    assert.equal(
      (await o("/invoices/group", "DELETE", { updatedAt: before.updatedAt }))
        .status,
      409,
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
