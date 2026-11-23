import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
test("Workspace hierarchy, customer account isolation, owner-only moves and durable email threading", async () => {
  const engine = await PGlite.create(),
    socket = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await socket.start();
  const port = socket.getServerConn().split(":").at(-1);
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET: "workspace-email-test-secret-at-least-32-characters",
    APP_ENCRYPTION_KEY: "d".repeat(64),
    APP_ORIGIN: "http://localhost:8080",
    DROPBOX_REDIRECT_URI:
      "http://localhost:8080/api/integrations/dropbox/callback",
    SMTP_ENABLED: "false",
    MAIL_FROM: "company@gmail.com",
    IMAP_USER: "company@gmail.com",
    IMAP_ENABLED: "false",
  });
  const { pool, transaction } = await import("../src/config/database.js"),
    { migrate } = await import("../scripts/migrate.js"),
    { createApp } = await import("../src/app.js"),
    { createUserRecord } =
      await import("../src/controllers/auth.controller.js"),
    { findUser } = await import("../src/models/user.model.js"),
    { saveCase } = await import("../src/controllers/cases.controller.js"),
    { env } = await import("../src/config/env.js");
  let server;
  try {
    const { readFile, readdir } = await import("node:fs/promises");
    await pool.query(
      "CREATE SCHEMA legalflow; CREATE TABLE legalflow.migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())",
    );
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((n) => n.endsWith(".sql") && n < "006")
      .sort()) {
      await pool.query(
        await readFile(
          new URL("../migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
      await pool.query("INSERT INTO legalflow.migrations(name) VALUES($1)", [
        name,
      ]);
    }
    const combined = await readFile(
      new URL("../scripts/sql/combined-update.sql", import.meta.url),
      "utf8",
    );
    await pool.query(combined);
    await pool.query(combined);
    await migrate();
    const user = async (name, role, actor, extra = {}) =>
      createUserRecord(
        {
          name,
          email: name + "@gmail.com",
          username: name,
          password: "Workspace-test-password-123",
          role,
          ...extra,
        },
        actor,
      );
    const owner = await user("owner", "owner", { role: "owner" }),
      manager = await user("manager", "manager", owner),
      staff = await user("staff", "staff", owner, { managerId: manager.id }),
      primary = await user("primary", "customer", owner),
      regional = await user("regional", "customer", owner, {
        clientId: primary.client_id,
      }),
      community = await user("community", "customer", owner, {
        clientId: primary.client_id,
      }),
      outsider = await user("outsider", "customer", owner);
    assert.equal(
      (
        await pool.query("SELECT data FROM legalflow.clients WHERE id=$1", [
          primary.client_id,
        ])
      ).rows[0].data.name,
      "primary",
      "Adding a customer login must not rename its company",
    );
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function client(name) {
      const r = await fetch(base + "/mobile/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identity: name,
          password: "Workspace-test-password-123",
        }),
      });
      const login = await r.json();
      assert.equal(r.status, 200, JSON.stringify(login));
      return async (path, method = "GET", body) => {
        const response = await fetch(base + path, {
          method,
          headers: {
            Authorization: "Bearer " + login.token,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        return {
          status: response.status,
          data: await response.json().catch(() => null),
        };
      };
    }
    const own = await client("owner"),
      reg = await client("regional"),
      comm = await client("community"),
      out = await client("outsider"),
      worker = await client("staff");
    const createWorkspace = async (
      name,
      kind,
      parentId = "",
      clientId = primary.client_id,
    ) => {
      const r = await own("/workspaces/new", "PUT", {
        name,
        kind,
        parentId,
        clientId,
        state: "GA",
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r.data.id;
    };
    const atlanta = await createWorkspace("Atlanta", "territory"),
      savannah = await createWorkspace("Savannah", "territory"),
      a = await createWorkspace("Westbrook", "community", atlanta),
      b = await createWorkspace("Generations", "community", atlanta),
      c = await createWorkspace("East Mill", "community", savannah);
    const grant = async (u, mode, ids) => {
      const fresh = await findUser(u.id);
      const r = await own("/workspace-access", "PUT", {
        userId: u.id,
        workspaceIds: ids,
        customerAccess: mode,
        updatedAt: fresh.updated_at.toISOString(),
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    };
    await grant(regional, "regional", [atlanta]);
    await grant(community, "community", [a]);
    const makeCase = async (number, workspaceId) => {
      const input = {
        id: randomUUID(),
        number,
        title: number,
        clientId: primary.client_id,
        residentName: "Tenant",
        type: "Eviction Notice",
        status: "Pending",
        priority: "Medium",
        staffId: staff.id,
        managerId: manager.id,
        workspaceId,
        state: "GA",
        moneyOwed: 1500,
      };
      await transaction((db) => saveCase(db, owner, input));
      return input.id;
    };
    const caseA = await makeCase("ATL-A", a),
      caseB = await makeCase("ATL-B", b),
      caseC = await makeCase("SAV-C", c);
    await (
      await import("../src/models/workspace.model.js")
    ).workspace(await findUser(regional.id));
    const regionalCases = (await reg("/workspace")).data.cases;
    assert.deepEqual(
      regionalCases.map((c) => c.id).sort(),
      [caseA, caseB].sort(),
    );
    assert.deepEqual(
      (await comm("/workspace")).data.cases.map((c) => c.id),
      [caseA],
    );
    assert.equal((await out("/workspace")).data.cases.length, 0);
    const ws = (await reg("/workspaces")).data.workspaces;
    assert.equal(ws.find((w) => w.id === atlanta).caseCount, 2);
    assert(ws.find((w) => w.id === a).caseIds.includes(caseA));
    assert(!ws.some((w) => w.id === savannah));
    const future = await createWorkspace(
        "Future Community",
        "community",
        atlanta,
      ),
      futureCase = await makeCase("ATL-NEW", future);
    assert(
      (await reg("/workspace")).data.cases.some((c) => c.id === futureCase),
      "Regional access must include newly created communities",
    );
    assert.equal(
      (
        await comm("/workspaces/new", "PUT", {
          name: "Denied",
          kind: "territory",
          clientId: primary.client_id,
        })
      ).status,
      403,
    );
    const cross = await own("/workspace-access", "PUT", {
      userId: outsider.id,
      workspaceIds: [a],
      customerAccess: "community",
      updatedAt: (await findUser(outsider.id)).updated_at.toISOString(),
    });
    assert.equal(cross.status, 422);
    let current = (await own("/workspace")).data.cases.find(
      (c) => c.id === caseA,
    );
    assert.equal(
      (
        await worker(`/cases/${caseA}/workspace`, "PATCH", {
          workspaceId: c,
          updatedAt: current.updatedAt,
        })
      ).status,
      403,
    );
    const draft = { ...current, workspaceId: c };
    assert.equal(
      (await worker(`/cases/${caseA}`, "PUT", draft)).status,
      403,
      "General case editor cannot bypass owner-only moves",
    );
    // Thread is addressed only to a registered customer who can access this exact case.
    env.SMTP_ENABLED = true;
    const payload = {
      caseId: caseA,
      customerUserId: community.id,
      subject: "Case documents",
      text: "Please review your case.",
      requestId: randomUUID(),
    };
    const sent = await own("/email/send", "POST", payload);
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    const tid = sent.data.id;
    assert.equal((await own("/email/send", "POST", payload)).data.reused, true);
    assert.equal(
      (
        await own("/email/send", "POST", {
          ...payload,
          subject: "Different subject",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legalflow.email_messages WHERE thread_id=$1",
          [tid],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await own("/email/send", "POST", {
          ...payload,
          requestId: randomUUID(),
          customerUserId: outsider.id,
        })
      ).status,
      422,
    );
    assert.equal((await out("/email/threads/" + tid)).status, 404);
    assert.equal((await comm("/email/threads/" + tid)).status, 200);
    assert.equal(
      (await reg("/email/threads/" + tid)).status,
      404,
      "Other customer users do not inherit private recipient email threads",
    );
    const { ingestIncoming, authenticatedSender, pollIncomingEmail } =
      await import("../src/services/incoming-email.service.js");
    const initial = (
      await pool.query(
        "SELECT * FROM legalflow.email_messages WHERE thread_id=$1",
        [tid],
      )
    ).rows[0];
    const mail = {
      from: { value: [{ address: "community@gmail.com" }] },
      to: { value: [{ address: env.MAIL_FROM }] },
      messageId: "<reply-one@gmail.com>",
      inReplyTo: initial.message_id,
      text: "Here is my reply.",
      headerLines: [
        {
          key: "authentication-results",
          line: "Authentication-Results: mx.google.com; dmarc=pass header.from=gmail.com",
        },
      ],
      attachments: [
        {
          filename: "notes.txt",
          content: Buffer.from("Test notes"),
          contentType: "text/plain",
        },
      ],
    };
    assert(authenticatedSender(mail));
    assert((await ingestIncoming({ ...mail, headerLines: [] })).ignored);
    assert(
      (
        await ingestIncoming({
          ...mail,
          from: { value: [{ address: "outsider@gmail.com" }] },
        })
      ).ignored,
    );
    assert((await ingestIncoming(mail)).imported);
    assert((await ingestIncoming(mail)).duplicate);
    assert.equal((await comm("/email/threads/" + tid)).data.messages.length, 2);
    const att = (await pool.query("SELECT * FROM legalflow.email_attachments"))
      .rows[0];
    assert.equal(att.state, "pending");
    assert.equal(att.payload.toString(), "Test notes");
    const { deliverEmailBatch } =
      await import("../src/services/email.service.js");
    let outbound;
    await pool.query(
      "UPDATE legalflow.email_outbox SET state='sent' WHERE id<>$1",
      [initial.outbox_id],
    );
    await deliverEmailBatch({
      limit: 1,
      send: async (msg) => {
        outbound = msg;
        return { accepted: [msg.to] };
      },
    });
    assert.equal(outbound.messageId, initial.message_id);
    assert.equal(outbound.to, "community@gmail.com");
    const reply = await comm("/email/send", "POST", {
      threadId: tid,
      subject: "Case documents",
      text: "Portal reply",
      requestId: randomUUID(),
    });
    assert.equal(reply.status, 201);
    const last = (
      await pool.query(
        "SELECT mail_headers,to_email FROM legalflow.email_outbox ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    assert.equal(last.to_email, env.MAIL_FROM);
    assert.equal(last.mail_headers.inReplyTo, mail.messageId);
    // Moving a case immediately revokes the old community access and email/doc/report/payment paths.
    current = (await own("/workspace")).data.cases.find((c) => c.id === caseA);
    assert.equal(
      (
        await own(`/cases/${caseA}/workspace`, "PATCH", {
          workspaceId: c,
          updatedAt: current.updatedAt,
        })
      ).status,
      200,
    );
    assert(!(await comm("/workspace")).data.cases.some((c) => c.id === caseA));
    assert.equal((await comm("/email/threads/" + tid)).status, 404);
    assert(
      (
        await ingestIncoming({
          ...mail,
          messageId: "<after-revocation@gmail.com>",
        })
      ).ignored,
    );
    assert.equal((await comm("/cases/" + caseC + "/report/pdf")).status, 404);
    // IMAP cursor initializes at current UID; a duplicate UID is harmless and source is not fetched for oversized mail.
    env.IMAP_ENABLED = true;
    let rawFetched = 0;
    let phase = 0;
    const fake = () => ({
      on() {},
      async connect() {},
      async mailboxOpen() {
        return { uidValidity: 123, uidNext: 10 };
      },
      async search() {
        return phase ? [10] : [];
      },
      async fetchOne(uid, query) {
        if (query.size) return { size: 20 * 1024 * 1024 };
        rawFetched++;
        return false;
      },
      async logout() {},
      close() {},
    });
    // Avoid external Dropbox calls from a pending attachment during fake IMAP tests.
    await pool.query("UPDATE legalflow.email_attachments SET attempts=8");
    assert((await pollIncomingEmail({ clientFactory: fake })).initialized);
    phase = 1;
    assert.equal((await pollIncomingEmail({ clientFactory: fake })).ignored, 1);
    assert.equal(rawFetched, 0);
    await pool.query(
      "UPDATE legalflow.email_attachments SET attempts=0 WHERE state='pending'",
    );
    let savedAttachment = 0;
    await pollIncomingEmail({
      clientFactory: fake,
      uploadAttachment: async (path, content) => {
        assert.match(path, /\/email\//);
        assert.equal(content.toString(), "Test notes");
        savedAttachment++;
      },
    });
    assert.equal(savedAttachment, 1);
    const stored = (
      await pool.query(
        "SELECT state,payload FROM legalflow.email_attachments WHERE id=$1",
        [att.id],
      )
    ).rows[0];
    assert.equal(stored.state, "ready");
    assert.equal(stored.payload, null);
    // Bulk moves are atomic, version checked and owner-only.
    const owned = (await own("/workspace")).data.cases,
      moving = owned.filter((row) => [caseB, futureCase].includes(row.id));
    assert.equal(
      (
        await worker("/workspaces/move-cases", "POST", {
          workspaceId: c,
          cases: moving.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
          })),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await own("/workspaces/move-cases", "POST", {
          workspaceId: c,
          cases: moving.map((row, i) => ({
            id: row.id,
            updatedAt: i ? "2000-01-01T00:00:00Z" : row.updatedAt,
          })),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT workspace_id FROM legalflow.cases WHERE id=$1",
          [caseB],
        )
      ).rows[0].workspace_id,
      b,
    );
    assert.equal(
      (
        await own("/workspaces/move-cases", "POST", {
          workspaceId: c,
          cases: moving.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
          })),
        })
      ).status,
      200,
    );
    const emptyParent = await createWorkspace("Empty workspace", "territory"),
      emptyChild = await createWorkspace(
        "Empty community",
        "community",
        emptyParent,
      );
    const version = async (id) =>
      (
        await pool.query(
          "SELECT updated_at FROM legalflow.workspaces WHERE id=$1",
          [id],
        )
      ).rows[0].updated_at.toISOString();
    assert.equal(
      (
        await worker("/workspaces/" + emptyChild, "DELETE", {
          updatedAt: await version(emptyChild),
        })
      ).status,
      403,
    );
    assert.equal(
      (await own("/workspaces/" + c, "DELETE", { updatedAt: await version(c) }))
        .status,
      409,
      "Cannot delete a community with cases",
    );
    assert.equal(
      (
        await own("/workspaces/" + savannah, "DELETE", {
          updatedAt: await version(savannah),
        })
      ).status,
      409,
      "Parent cannot delete descendant cases",
    );
    assert.equal(
      (
        await own("/workspaces/" + emptyParent, "DELETE", {
          updatedAt: await version(emptyParent),
        })
      ).status,
      409,
      "Parent must have no communities",
    );
    assert.equal(
      (
        await own("/workspaces/" + emptyChild, "DELETE", {
          updatedAt: "2000-01-01",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await own("/workspaces/" + emptyChild, "DELETE", {
          updatedAt: await version(emptyChild),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await own("/workspaces/" + emptyParent, "DELETE", {
          updatedAt: await version(emptyParent),
        })
      ).status,
      200,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM legalflow.cases"))
        .rows[0].n,
      4,
      "Deleting empty groups must not delete cases",
    );
    env.IMAP_ENABLED = false;
    env.SMTP_ENABLED = false;
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await engine.close();
  }
});
