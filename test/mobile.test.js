import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
test("native sessions preserve browser CSRF, case permissions, revocation and OAuth state", async () => {
  const db = await PGlite.create(),
    socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await socket.start();
  const port = socket.getServerConn().split(":").at(-1);
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET: "native-contract-test-secret-at-least-32-characters",
    APP_ENCRYPTION_KEY: "c".repeat(64),
    APP_ORIGIN: "https://frontend.invalid",
    DROPBOX_REDIRECT_URI:
      "https://frontend.invalid/api/integrations/dropbox/callback",
    DROPBOX_APP_KEY: "test-app",
    DROPBOX_APP_SECRET: "test-secret",
    SMTP_ENABLED: "false",
  });
  const { pool } = await import("../src/config/database.js"),
    { migrate } = await import("../scripts/migrate.js"),
    { createApp } = await import("../src/app.js"),
    { createUserRecord } = await import(
      "../src/controllers/auth.controller.js"
    ),
    { tokenHash } = await import("../src/services/mobile-auth.service.js");
  let server;
  try {
    await migrate();
    await migrate();
    const sql = await readFile(
      new URL("../scripts/sql/mobile-update.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const owner = await createUserRecord(
      {
        name: "Owner",
        email: "owner@native.invalid",
        username: "owner",
        password: "Native-password-123",
        role: "owner",
      },
      { role: "owner", id: null },
    );
    const manager = await createUserRecord(
      {
        name: "Manager",
        email: "manager@native.invalid",
        username: "manager",
        password: "Native-password-123",
        role: "manager",
      },
      owner,
    );
    const staff = await createUserRecord(
      {
        name: "Staff",
        email: "staff@native.invalid",
        username: "staff",
        password: "Native-password-123",
        role: "staff",
        managerId: manager.id,
      },
      owner,
    );
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const root = `http://127.0.0.1:${server.address().port}/api`;
    const req = async (path, method = "GET", body, token, extra = {}) => {
      const response = await fetch(root + path, {
        method,
        redirect: "manual",
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        data: await response.json().catch(() => null),
        headers: response.headers,
      };
    };
    const login = async (identity) =>
      req("/mobile/auth/login", "POST", {
        identity,
        password: "Native-password-123",
      });
    assert.equal(
      (
        await req("/mobile/auth/login", "POST", {
          identity: "owner",
          password: "wrong",
        })
      ).status,
      401,
    );
    const access = await login("owner");
    assert.equal(access.status, 200);
    assert(!access.headers.get("set-cookie"));
    const token = access.data.token;
    const stored = (
      await pool.query(
        "SELECT * FROM legalflow.mobile_sessions WHERE token_hash=$1",
        [tokenHash(token)],
      )
    ).rows[0];
    assert(stored);
    assert.notEqual(stored.token_hash, token);
    assert.equal(
      (await req("/workspace", "GET", undefined, token)).status,
      200,
    );
    assert.equal(
      (await req("/preferences", "PATCH", { savedViews: [] }, token)).status,
      200,
      "Native mutation does not need browser cookies/CSRF",
    );
    assert.equal(
      (await req("/preferences", "PATCH", { savedViews: [] })).status,
      403,
      "Browser CSRF protection remains enabled",
    );
    assert.equal(
      (await req("/workspace", "GET", undefined, "invalid")).status,
      401,
    );
    const registered = await req("/mobile/auth/register", "POST", {
      name: "Client",
      email: "client@native.invalid",
      username: "client",
      password: "Native-password-123",
      role: "owner",
      clientId: "forged",
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.data.user.role, "customer");
    const clientToken = registered.data.token;
    const cw = await req("/workspace", "GET", undefined, clientToken);
    assert.equal(cw.data.cases.length, 0);
    assert.equal((await req("/users", "POST", {}, clientToken)).status, 403);
    assert.equal(
      (await req("/email/status", "GET", undefined, clientToken)).status,
      403,
    );
    assert.equal(
      (
        await req(
          "/mobile/integrations/dropbox/connect",
          "POST",
          undefined,
          clientToken,
        )
      ).status,
      403,
    );
    const connect = await req(
      "/mobile/integrations/dropbox/connect",
      "POST",
      undefined,
      token,
    );
    assert.equal(connect.status, 200);
    const state = new URL(connect.data.url).searchParams.get("state");
    assert(state.startsWith("mobile_"));
    assert.equal(
      (
        await req(
          "/integrations/dropbox/callback?state=mobile_forged&code=test",
        )
      ).status,
      403,
    );
    const cancelled = await req(
      `/integrations/dropbox/callback?state=${state}&error=access_denied`,
    );
    assert.equal(cancelled.status, 302);
    assert.equal(
      cancelled.headers.get("location"),
      "legalflow://integration/dropbox?status=cancelled",
    );
    assert.equal(
      (
        await req(
          `/integrations/dropbox/callback?state=${state}&error=access_denied`,
        )
      ).status,
      403,
      "OAuth state is single use",
    );
    const payment = await req(
      "/mobile/payments/return?invoiceId=inv1&payment=success",
    );
    assert.equal(payment.status, 302);
    assert.equal(
      payment.headers.get("location"),
      "legalflow://payment?invoiceId=inv1&payment=success",
    );
    assert.equal(
      (
        await req(
          "/mobile/payments/return?invoiceId=inv1&payment=success&redirect=https://attacker.invalid",
        )
      ).headers.get("location"),
      "legalflow://payment?invoiceId=inv1&payment=success",
    );
    const staffToken = (await login("staff")).data.token;
    let workspace = (await req("/workspace", "GET", undefined, token)).data;
    const user = workspace.users.find((u) => u.id === staff.id);
    assert.equal(
      (
        await req(
          `/users/${staff.id}/access`,
          "PATCH",
          {
            role: "staff",
            status: "Inactive",
            managerId: manager.id,
            updatedAt: user.updatedAt,
          },
          token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await req("/workspace", "GET", undefined, staffToken)).status,
      401,
    );
    assert.equal(
      (await req("/mobile/auth/logout", "POST", undefined, token)).status,
      200,
    );
    assert.equal(
      (await req("/workspace", "GET", undefined, token)).status,
      401,
    );
    await pool.query(
      "UPDATE legalflow.mobile_sessions SET expires_at=now()-interval '1 day' WHERE token_hash=$1",
      [tokenHash(clientToken)],
    );
    assert.equal(
      (await req("/workspace", "GET", undefined, clientToken)).status,
      401,
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
