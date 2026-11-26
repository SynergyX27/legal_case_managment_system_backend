import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
test("private invoice capabilities support anonymous view, PDF, safe checkout replacement and confirmed grouped payments", async () => {
  const db = await PGlite.create(),
    socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await socket.start();
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${socket.getServerConn().split(":").at(-1)}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET: "public-invoice-only-contract-secret-0123456789",
    APP_ENCRYPTION_KEY: "a".repeat(64),
    APP_ORIGIN: "http://localhost:8080",
    DROPBOX_REDIRECT_URI:
      "http://localhost:8080/api/integrations/dropbox/callback",
    STRIPE_SECRET_KEY: "sk_test_public_local_contract",
    STRIPE_WEBHOOK_SECRET: "whsec_public_local_contract",
  });
  const { pool } = await import("../src/config/database.js"),
    { migrate } = await import("../scripts/migrate.js"),
    { createApp } = await import("../src/app.js"),
    { createUserRecord } =
      await import("../src/controllers/auth.controller.js"),
    { stripeClient, createCheckout } =
      await import("../src/services/payments.service.js"),
    { publicInvoice } =
      await import("../src/services/public-invoice.service.js");
  let server;
  try {
    await migrate();
    const { readFile } = await import("node:fs/promises");
    const update = await readFile(
      new URL("../scripts/sql/public-invoice-update.sql", import.meta.url),
      "utf8",
    );
    await pool.query(update);
    await pool.query(update);
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
        { role: "owner" },
      );
    const owner = await create("owner", "owner"),
      manager = await create("manager", "manager"),
      staff = await create("staff", "staff", { managerId: manager.id }),
      customer = await create("customer", "customer");
    await pool.query(
      "INSERT INTO legalflow.workspaces(id,client_id,kind,name) VALUES('territory',$1,'territory','Georgia')",
      [customer.client_id],
    );
    await pool.query(
      "INSERT INTO legalflow.workspaces(id,client_id,parent_id,kind,name) VALUES('community',$1,'territory','community','Atlanta')",
      [customer.client_id],
    );
    for (const id of ["a", "b"]) {
      const data = {
        id,
        number: id,
        clientId: customer.client_id,
        residentName: `Tenant ${id}`,
        residentAddress: "2035 Example Lane",
        propertyType: "APT",
        serviceDate: "2026-12-15",
        status: "Pending",
        moneyOwed: 1500,
        notes: "PRIVATE INTERNAL NOTE",
        residentPhone: "PRIVATE PHONE",
      };
      await pool.query(
        "INSERT INTO legalflow.cases(id,number,client_id,staff_id,manager_id,workspace_id,data) VALUES($1,$1,$2,$3,$4,'community',$5)",
        [id, customer.client_id, staff.id, manager.id, data],
      );
    }
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    let cookie = "",
      csrf = "";
    async function req(
      path,
      method = "GET",
      body,
      anonymous = false,
      origin = "http://localhost:8080",
    ) {
      const r = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(!anonymous ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!anonymous)
        cookie = r.headers.get("set-cookie")?.split(";")[0] || cookie;
      const data = r.headers.get("content-type")?.includes("pdf")
        ? Buffer.from(await r.arrayBuffer())
        : await r.json();
      if (!anonymous && data.csrfToken) csrf = data.csrfToken;
      return { status: r.status, data, headers: r.headers };
    }
    await req("/auth/session");
    assert.equal(
      (
        await req("/auth/login", "POST", {
          identity: "owner",
          password: "Test-password-12345",
        })
      ).status,
      200,
    );
    const inv = {
      caseId: "a",
      caseIds: ["a", "b"],
      clientId: customer.client_id,
      date: "2026-11-26",
      dueDate: "2026-12-26",
      lines: [
        { caseId: "a", description: "Setout A", qty: 1, price: 650 },
        { caseId: "b", description: "Setout B", qty: 1, price: 650 },
      ],
      discount: 200,
      taxRate: 0,
      status: "Sent",
    };
    assert.equal((await req("/invoices/public-test", "PUT", inv)).status, 200);
    assert.equal(
      (await req("/invoices/draft-test", "PUT", { ...inv, status: "Draft" }))
        .status,
      200,
    );
    assert.equal(
      (await req("/invoices/draft-test/public-link", "POST", {})).status,
      409,
    );
    const link = (await req("/invoices/public-test/public-link", "POST", {}))
      .data;
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get(
      "token",
    );
    assert.equal(token.length, 43);
    const stored = (
      await pool.query(
        "SELECT token_hash FROM legalflow.invoice_public_links WHERE token_hash=$1",
        [createHash("sha256").update(token).digest("hex")],
      )
    ).rows[0];
    assert(stored);
    assert.notEqual(stored.token_hash, token);
    const open = (path, body = { token }) =>
      req(`/public/invoices/${path}`, "POST", body, true);
    let view = await open("view");
    assert.equal(view.status, 200);
    assert.equal(view.data.invoice.totals.total, 110000);
    assert.equal(view.data.invoice.lines.length, 2);
    assert(!JSON.stringify(view.data).includes("PRIVATE INTERNAL NOTE"));
    assert(!JSON.stringify(view.data).includes("PRIVATE PHONE"));
    assert.equal(view.headers.get("referrer-policy"), "no-referrer");
    assert.match(view.headers.get("x-robots-tag"), /noindex/);
    assert.equal((await req("/workspace", "GET", undefined, true)).status, 401);
    assert.equal(
      (await req("/invoices/public-test/pdf", "GET", undefined, true)).status,
      401,
    );
    assert.equal((await open("view", { token: "a".repeat(43) })).status, 404);
    assert.equal(
      (await open("view", { token, invoiceId: "draft-test" })).status,
      422,
    );
    const pdf = await open("pdf");
    assert.equal(pdf.status, 200);
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    assert.equal(
      (
        await req(
          "/public/invoices/checkout",
          "POST",
          { token },
          true,
          "https://untrusted.invalid",
        )
      ).status,
      403,
    );
    const stripe = stripeClient(),
      sessions = new Map(),
      keys = new Map();
    let creates = 0,
      expires = 0;
    stripe.checkout.sessions.create = async (p, options) => {
      if (keys.has(options.idempotencyKey))
        return sessions.get(keys.get(options.idempotencyKey));
      creates++;
      const id = "cs_" + randomUUID(),
        s = {
          ...p,
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          amount_total: p.line_items[0].price_data.unit_amount,
          currency: "usd",
          livemode: false,
          payment_status: "unpaid",
          status: "open",
        };
      sessions.set(id, s);
      keys.set(options.idempotencyKey, id);
      return s;
    };
    stripe.checkout.sessions.retrieve = async (id) => sessions.get(id);
    stripe.checkout.sessions.expire = async (id) => {
      expires++;
      const s = sessions.get(id);
      s.status = "expired";
      return s;
    };
    // Begin an old portal checkout; anonymous payment must safely replace it.
    await createCheckout(customer, "public-test");
    const oldId = [...sessions.keys()][0];
    const pay = await open("checkout");
    assert.equal(pay.status, 200, JSON.stringify(pay.data));
    assert.equal(creates, 2);
    assert.equal(expires, 1);
    assert.equal(sessions.get(oldId).status, "expired");
    const session = [...sessions.values()].find((s) => s.status === "open");
    assert.equal(session.amount_total, 110000);
    assert.equal(new URL(session.success_url).pathname, "/pay/invoice");
    assert.equal(
      new URLSearchParams(new URL(session.success_url).hash.slice(1)).get(
        "token",
      ),
      token,
    );
    await open("checkout");
    assert.equal(creates, 2, "Retry reuses the active checkout");
    assert.equal(
      (await open("view")).data.invoice.status,
      "Sent",
      "A redirect does not mark an invoice paid",
    );
    session.status = "complete";
    session.payment_status = "paid";
    session.payment_intent = "pi_public_test";
    assert.equal((await open("status")).data.status, "Paid");
    assert.equal((await open("status")).data.status, "Paid");
    assert.deepEqual((await open("checkout")).data, { paid: true });
    view = await open("view");
    assert.equal(view.data.invoice.status, "Paid");
    const { casePaidTotals } =
      await import("../src/services/case-balance.service.js");
    const balances = await casePaidTotals(pool, ["a", "b"]);
    assert.equal(balances.get("a"), 550);
    assert.equal(balances.get("b"), 550);
    assert.equal(
      (await req("/invoices/public-test/public-links", "DELETE")).status,
      200,
    );
    assert.equal((await open("view")).status, 404);
    assert.equal((await open("pdf")).status, 404);
    assert.equal((await open("checkout")).status, 404);
    const renewed = (await req("/invoices/public-test/public-link", "POST", {}))
      .data;
    const renewedToken = new URLSearchParams(
      new URL(renewed.url).hash.slice(1),
    ).get("token");
    assert.equal((await open("view", { token: renewedToken })).status, 200);
    await pool.query(
      "UPDATE legalflow.invoice_public_links SET expires_at=now()-interval '1 second' WHERE invoice_id='public-test'",
    );
    await assert.rejects(publicInvoice(renewedToken));
    assert.equal((await open("view", { token: renewedToken })).status, 404);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
