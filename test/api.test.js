import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
// A disposable PostgreSQL engine: never uses the deployment database or seeds runtime data.
test("HTTP API, PostgreSQL persistence and access isolation", async (t) => {
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await socket.start();
  const address = socket.getServerConn ? socket.getServerConn() : null;
  // The server exposes its listening address through getAddress on recent releases.
  const port =
    socket.getServer?.()?.address()?.port ??
    socket.server?.address()?.port ??
    socket.port;
  assert(port, "PGlite socket port is available");
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET:
      "local-integration-only-0123456789-abcdefghijklmnopqrstuvwxyz",
    APP_ENCRYPTION_KEY: "a".repeat(64),
    APP_ORIGIN: "http://localhost:8080",
    DROPBOX_APP_KEY: "test-app",
    DROPBOX_APP_SECRET: "test-secret",
    DROPBOX_REFRESH_TOKEN: "",
    DROPBOX_REDIRECT_URI:
      "http://localhost:8080/api/integrations/dropbox/callback",
    MAX_FILE_MB: "1",
  });
  const { pool } = await import("../src/config/database.js");
  const { migrate } = await import("../scripts/migrate.js");
  const { createApp } = await import("../src/app.js");
  const { createUserRecord } =
    await import("../src/controllers/auth.controller.js");
  let server;
  try {
    await migrate();
    await migrate();
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const root = `http://127.0.0.1:${server.address().port}/api`;
    class Client {
      cookie = "";
      csrf = "";
      async request(
        path,
        {
          method = "GET",
          body,
          token = true,
          origin = "http://localhost:8080",
          headers = {},
        } = {},
      ) {
        const form = body instanceof FormData;
        const r = await fetch(root + path, {
          method,
          headers: {
            ...(this.cookie ? { Cookie: this.cookie } : {}),
            Origin: origin,
            ...(body && !form ? { "Content-Type": "application/json" } : {}),
            ...(token && this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
            ...headers,
          },
          body:
            body === undefined ? undefined : form ? body : JSON.stringify(body),
          redirect: "manual",
        });
        const cookie = r.headers.get("set-cookie");
        if (cookie) this.cookie = cookie.split(";")[0];
        const v = await r.json().catch(() => null);
        if (v?.csrfToken) this.csrf = v.csrfToken;
        return { status: r.status, data: v, headers: r.headers };
      }
      async login(identity, password = "Test-password-12345") {
        await this.request("/auth/session");
        return this.request("/auth/login", {
          method: "POST",
          body: { identity, password },
        });
      }
    }
    const ownerUser = await createUserRecord(
      {
        name: "Test Owner",
        email: "owner@test.invalid",
        username: "owner",
        password: "Test-password-12345",
        role: "owner",
      },
      { role: "owner", id: null },
    );
    const owner = new Client();
    assert.equal((await owner.login("owner")).status, 200);
    const anonymous = new Client();
    assert.equal((await anonymous.request("/workspace")).status, 401);
    assert.equal(
      (
        await owner.request("/users", {
          method: "POST",
          body: {},
          token: false,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.request("/users", {
          method: "POST",
          body: {},
          origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    async function addUser(username, role) {
      const r = await owner.request("/users", {
        method: "POST",
        body: {
          name: username,
          email: `${username}@test.invalid`,
          username,
          password: "Test-password-12345",
          role,
          address: "Customer address",
        },
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data.id;
    }
    const managerId = await addUser("manager", "manager"),
      staffId = await addUser("staff", "staff"),
      strangerId = await addUser("stranger", "staff");
    const customerId = await addUser("customer", "customer");
    const customer = new Client();
    assert.equal((await customer.login("customer")).status, 200);
    const customerWorkspace = (await customer.request("/workspace")).data;
    const clientId = customerWorkspace.users.find(
      (u) => u.id === customerId,
    ).clientId;
    assert(clientId);
    assert.equal(customerWorkspace.clients.length, 1);
    assert.equal(customerWorkspace.cases.length, 0);
    assert(!JSON.stringify(customerWorkspace).includes("password_hash"));
    const registered = new Client();
    await registered.request("/auth/session");
    const signup = await registered.request("/auth/register", {
      method: "POST",
      body: {
        name: "Registered Customer",
        email: "registered@test.invalid",
        username: "registered",
        password: "Test-password-12345",
        role: "owner",
        clientId,
      },
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.data.user.role, "customer");
    assert.notEqual(signup.data.user.clientId, clientId);
    assert.equal((await owner.request("/workspace")).data.clients.length, 2);
    const caseId = randomUUID();
    const data = {
      id: caseId,
      number: "TEST-CASE-001",
      title: "Test case",
      clientId,
      residentName: "Tenant",
      type: "Eviction Notice",
      status: "Pending",
      priority: "Medium",
      managerId,
      staffId,
      notes: "Internal only",
    };
    assert.equal(
      (
        await customer.request(`/cases/${caseId}`, {
          method: "PUT",
          body: data,
        })
      ).status,
      403,
    );
    assert.equal(
      (await owner.request(`/cases/${caseId}`, { method: "PUT", body: data }))
        .status,
      200,
    );
    let w = (await owner.request("/workspace")).data;
    let c = w.cases.find((c) => c.id === caseId);
    assert.equal(c.notes, "Internal only");
    assert.equal(
      (await customer.request("/workspace")).data.cases[0].notes,
      "",
    );
    assert.equal((await registered.request("/workspace")).data.cases.length, 0);
    const stale = { ...c, status: "Active" };
    assert.equal(
      (await owner.request(`/cases/${caseId}`, { method: "PUT", body: stale }))
        .status,
      200,
    );
    assert.equal(
      (await owner.request(`/cases/${caseId}`, { method: "PUT", body: stale }))
        .status,
      409,
    );
    const staff = new Client();
    await staff.login("staff");
    assert.equal((await staff.request("/workspace")).data.cases.length, 1);
    const stranger = new Client();
    await stranger.login("stranger");
    assert.equal((await stranger.request("/workspace")).data.cases.length, 0);
    const comment = await staff.request(`/cases/${caseId}/comments`, {
      method: "POST",
      body: { text: "Visited the property" },
    });
    assert.equal(comment.status, 200);
    assert.equal(
      (await customer.request("/workspace")).data.cases[0].comments.length,
      0,
    );
    const invoiceBase = {
      caseId,
      clientId,
      date: "2026-11-01",
      dueDate: "2026-12-01",
      lines: [{ description: "Service fee", qty: 1, price: 100 }],
      taxRate: 10,
      status: "Sent",
    };
    const inv1 = randomUUID(),
      inv2 = randomUUID();
    assert.equal(
      (
        await owner.request(`/invoices/${inv1}`, {
          method: "PUT",
          body: { ...invoiceBase, id: inv1 },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await owner.request(`/invoices/${inv2}`, {
          method: "PUT",
          body: { ...invoiceBase, id: inv2, status: "Draft" },
        })
      ).status,
      200,
    );
    w = (await owner.request("/workspace")).data;
    assert.equal(w.invoices.length, 2);
    assert.notEqual(w.invoices[0].number, w.invoices[1].number);
    assert.equal(
      (await customer.request("/workspace")).data.invoices.length,
      1,
    );
    assert.equal(
      (await registered.request("/workspace")).data.invoices.length,
      0,
    );
    assert.equal(
      (
        await staff.request(`/invoices/${inv1}`, {
          method: "PUT",
          body: { ...invoiceBase, id: inv1 },
        })
      ).status,
      403,
    );

    const draftInvoice = w.invoices.find((i) => i.id === inv2);
    assert.equal(
      (
        await owner.request(`/invoices/${inv2}`, {
          method: "PUT",
          body: { ...draftInvoice, status: "Paid" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await owner.request(`/invoices/${inv2}`, {
          method: "PUT",
          body: { ...draftInvoice, status: "Sent" },
        })
      ).status,
      409,
    );
    assert.equal(
      (await customer.request("/workspace")).data.invoices.length,
      2,
    );
    assert.equal(
      (await owner.request(`/cases/${caseId}`, { method: "DELETE" })).status,
      409,
    );
    const deniedChat = await customer.request("/conversations", {
      method: "POST",
      body: { otherId: strangerId },
    });
    assert.equal(deniedChat.status, 403);
    const chat = await customer.request("/conversations", {
      method: "POST",
      body: { otherId: staffId },
    });
    assert.equal(chat.status, 200);
    const chatId = chat.data.id;
    assert.equal(
      (
        await customer.request("/conversations", {
          method: "POST",
          body: { otherId: staffId },
        })
      ).data.id,
      chatId,
    );
    assert.equal(
      (
        await registered.request(`/conversations/${chatId}/messages`, {
          method: "POST",
          body: { text: "Unauthorized" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await customer.request(`/conversations/${chatId}/messages`, {
          method: "POST",
          body: { text: "Hello team" },
        })
      ).status,
      201,
    );
    w = (await staff.request("/workspace")).data;
    assert.equal(w.conversations[0].messages[0].text, "Hello team");
    const last = w.conversations[0].messages[0].id;
    assert.equal(
      (
        await staff.request(`/conversations/${chatId}/read`, {
          method: "POST",
          body: { lastMessageId: last },
        })
      ).status,
      200,
    );
    assert.equal(
      (await staff.request("/workspace")).data.chatRead[`${staffId}:${chatId}`],
      last,
    );
    assert.equal((await customer.request("/integrations/dropbox")).status, 403);
    const oauth = await owner.request("/integrations/dropbox/connect", {
      method: "POST",
    });
    assert.equal(oauth.status, 200);
    const url = new URL(oauth.data.url);
    assert.equal(url.searchParams.get("token_access_type"), "offline");
    assert(!url.searchParams.has("client_secret"));
    assert.equal(
      (
        await owner.request(
          "/integrations/dropbox/callback?state=wrong&code=unused",
        )
      ).status,
      403,
    );
    const form = new FormData();
    form.append("caseId", caseId);
    form.append(
      "file",
      new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" }),
      "test.pdf",
    );
    assert.equal(
      (await owner.request("/documents", { method: "POST", body: form }))
        .status,
      503,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM legalflow.documents"))
        .rows[0].n,
      0,
    );
    // Provider contract tests use an isolated HTTP stub, never a production storage account.
    const nativeFetch = globalThis.fetch;
    const remoteFiles = new Map();
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (!url.includes("dropboxapi.com")) return nativeFetch(input, options);
      if (url.endsWith("/oauth2/token"))
        return new Response(
          JSON.stringify({
            access_token: "test-access",
            refresh_token: "test-refresh",
            expires_in: 14400,
          }),
          { status: 200 },
        );
      const path = options?.headers?.["Dropbox-API-Arg"]
        ? JSON.parse(options.headers["Dropbox-API-Arg"]).path
        : JSON.parse(options.body || "{}").path;
      if (url.endsWith("/files/upload")) {
        remoteFiles.set(path, Buffer.from(options.body));
        return Response.json({ id: "test-provider-id", path_lower: path });
      }
      if (url.endsWith("/files/download"))
        return new Response(remoteFiles.get(path) || null, {
          status: remoteFiles.has(path) ? 200 : 409,
        });
      if (url.endsWith("/files/delete_v2")) {
        remoteFiles.delete(path);
        return Response.json({ metadata: {} });
      }
      throw new Error("Unexpected Dropbox API request");
    };
    try {
      const { saveGrant } = await import("../src/services/dropbox.service.js");
      await saveGrant("test-authorization-code");
      const encrypted = (
        await pool.query(
          "SELECT value FROM legalflow.settings WHERE key='dropbox_oauth'",
        )
      ).rows[0].value;
      assert(!encrypted.includes("test-refresh"));
      const uploadId = randomUUID();
      const uploaded = await owner.request("/documents", {
        method: "POST",
        body: form,
        headers: { "X-Upload-Id": uploadId },
      });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
      assert.equal(uploaded.data.id, uploadId);
      assert.equal(remoteFiles.size, 1);
      assert.equal(
        (
          await owner.request("/documents", {
            method: "POST",
            body: form,
            headers: { "X-Upload-Id": uploadId },
          })
        ).status,
        200,
      );
      assert.equal(remoteFiles.size, 1);
      const download = await nativeFetch(
        root + `/documents/${uploadId}/content`,
        { headers: { Cookie: customer.cookie } },
      );
      assert.equal(download.status, 200);
      assert.equal(await download.text(), "%PDF-1.7\n%%EOF");
      assert.equal(
        (await registered.request(`/documents/${uploadId}/content`)).status,
        404,
      );
      const companyForm = new FormData();
      companyForm.append(
        "file",
        new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" }),
        "company.pdf",
      );
      const companyDoc = await owner.request("/documents", {
        method: "POST",
        body: companyForm,
      });
      assert.equal(companyDoc.status, 201);
      assert.equal(
        (await customer.request(`/documents/${companyDoc.data.id}/content`))
          .status,
        403,
      );
      assert.equal(
        (
          await staff.request(`/documents/${companyDoc.data.id}`, {
            method: "DELETE",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await owner.request(`/documents/${companyDoc.data.id}`, {
            method: "DELETE",
          })
        ).status,
        200,
      );
      assert.equal(
        (await staff.request(`/documents/${uploadId}`, { method: "DELETE" }))
          .status,
        200,
      );
      assert.equal(remoteFiles.size, 0);
      assert.equal(
        (await owner.request("/workspace")).data.companyDocuments.length,
        0,
      );
      const unsafe = new FormData();
      unsafe.append(
        "file",
        new Blob(["<script>alert(1)</script>"], { type: "image/png" }),
        "fake.png",
      );
      assert.equal(
        (await owner.request("/documents", { method: "POST", body: unsafe }))
          .status,
        422,
      );
    } finally {
      globalThis.fetch = nativeFetch;
    }
    const pref = {
      savedViews: [
        {
          id: "custom-view",
          name: "Test view",
          filters: {
            status: ["Active"],
            clientId: "",
            staffId: "",
            type: "",
            dateFrom: "",
            dateTo: "",
            search: "",
          },
        },
      ],
    };
    assert.equal(
      (await owner.request("/preferences", { method: "PATCH", body: pref }))
        .status,
      200,
    );
    assert.equal(
      (await owner.request("/workspace")).data.savedViews[0].name,
      "Test view",
    );
    assert.equal(
      (await customer.request("/workspace")).data.savedViews.length,
      0,
    );
    const eventId = randomUUID();
    assert.equal(
      (
        await staff.request(`/events/${eventId}`, {
          method: "PUT",
          body: {
            id: eventId,
            title: "Visit",
            date: "2026-11-15",
            time: "09:00",
            staffId,
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (await stranger.request(`/events/${eventId}`, { method: "DELETE" }))
        .status,
      403,
    );
    const newSession = new Client();
    assert.equal((await newSession.login("customer@test.invalid")).status, 200);
    assert.equal((await newSession.request("/workspace")).data.cases.length, 1);
    assert.equal(
      (
        await owner.request(`/users/${customerId}/access`, {
          method: "PATCH",
          body: { role: "customer", status: "Inactive" },
        })
      ).status,
      200,
    );
    assert.equal((await customer.request("/workspace")).status, 401);
    assert.equal((await newSession.request("/workspace")).status, 401);
    console.log(
      "Verified authentication, permissions, persistence, cases, multi-invoice billing, chat, notifications, preferences and OAuth setup",
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
