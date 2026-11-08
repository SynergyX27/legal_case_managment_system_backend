import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
test("transactional email events, recipient routing, retry leases and failure recovery", async () => {
  const db = await PGlite.create(),
    socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await socket.start();
  const port = socket.getServerConn().split(":").at(-1);
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/test`,
    DB_SSL_MODE: "disable",
    DB_POOL_MAX: "1",
    SESSION_SECRET: "email-test-secret-at-least-32-characters",
    APP_ENCRYPTION_KEY: "c".repeat(64),
    APP_ORIGIN: "http://localhost:8080",
    DROPBOX_REDIRECT_URI:
      "http://localhost:8080/api/integrations/dropbox/callback",
    SMTP_ENABLED: "false",
    MAIL_FROM: "delivery@test.invalid",
    MAIL_FROM_NAME: "LegalFlow",
  });
  const { pool, transaction } = await import("../src/config/database.js");
  const { migrate } = await import("../scripts/migrate.js");
  const { createUserRecord } =
    await import("../src/controllers/auth.controller.js");
  const {
    queueCaseOpened,
    queueInvoiceIssued,
    queuePaymentCompleted,
    emailTemplate,
  } = await import("../src/services/email-events.service.js");
  const { deliverEmailBatch, safeMailError } =
    await import("../src/services/email.service.js");
  try {
    await migrate();
    await migrate();
    const sql = await readFile(
      new URL("../scripts/sql/email-update.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const user = (name, role, actor, managerId) =>
      createUserRecord(
        {
          name,
          email: `${name}@test.invalid`,
          username: name,
          password: "Email-test-password-123",
          role,
          managerId,
        },
        actor,
      );
    const owner = await user("owner", "owner", { id: null, role: "owner" });
    await user("secondowner", "owner", owner);
    const inactiveOwner = await user("inactiveowner", "owner", owner);
    await pool.query(
      "UPDATE legalflow.users SET status='Inactive' WHERE id=$1",
      [inactiveOwner.id],
    );
    const manager = await user("manager", "manager", owner),
      staff = await user("staff", "staff", owner, manager.id),
      customer = await user("customer", "customer", owner);
    await user("unassignedstaff", "staff", owner, manager.id);
    const c = {
      id: randomUUID(),
      number: "CASE-EMAIL-1",
      clientId: customer.client_id,
      staffId: staff.id,
      managerId: manager.id,
      status: "Pending",
    };
    await pool.query(
      "INSERT INTO legalflow.cases(id,number,client_id,staff_id,manager_id,data) VALUES($1,$2,$3,$4,$5,$6)",
      [c.id, c.number, c.clientId, c.staffId, c.managerId, c],
    );
    const inv = {
      id: randomUUID(),
      caseId: c.id,
      clientId: c.clientId,
      number: "INV-EMAIL-1",
      dueDate: "2026-12-01",
      lines: [{ qty: 2, price: 100 }],
      taxRate: 10,
      status: "Sent",
    };
    await assert.rejects(
      transaction(async (q) => {
        await queueCaseOpened(q, c);
        throw new Error("rollback");
      }),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM legalflow.email_outbox",
        )
      ).rows[0].n,
      0,
      "A rollback leaves no email to send",
    );
    await transaction(async (q) => {
      await queueCaseOpened(q, c);
      await queueCaseOpened(q, c);
      await queueInvoiceIssued(q, inv);
      await queueInvoiceIssued(q, inv);
      await queuePaymentCompleted(q, inv, "manual");
      await queuePaymentCompleted(q, inv, "manual");
    });
    let rows = (await pool.query("SELECT * FROM legalflow.email_outbox")).rows;
    assert.equal(
      rows.filter((r) => r.event_key.startsWith("case.created")).length,
      1,
    );
    assert.equal(
      rows.filter((r) => r.event_key.startsWith("invoice.issued")).length,
      1,
    );
    const receipts = rows.filter((r) => r.event_key.startsWith("invoice.paid"));
    assert.deepEqual(
      receipts.map((r) => r.to_email).sort(),
      [
        "customer@test.invalid",
        "owner@test.invalid",
        "secondowner@test.invalid",
        "manager@test.invalid",
        "staff@test.invalid",
      ].sort(),
    );
    assert(receipts.every((r) => r.text_body.includes("$220.00")));
    const template = emailTemplate({
      name: "<img src=x onerror=alert(1)>",
      title: "<script>alert(1)</script>",
      description: "A & B",
      details: [["<x>", '"quoted"']],
      url: "https://example.invalid/invoices?a=1&b=2",
    });
    assert(!template.html.includes("<script>"));
    assert(template.html.includes("&lt;script&gt;"));
    assert(template.html.includes("&amp;"));
    const delivered = [];
    const sender = async (message) => {
      delivered.push(message);
      return { accepted: [message.to], rejected: [] };
    };
    const reports = await Promise.all([
      deliverEmailBatch({ send: sender, limit: 10 }),
      deliverEmailBatch({ send: sender, limit: 10 }),
    ]);
    assert.equal(
      reports.reduce((n, r) => n + r.sent, 0),
      7,
    );
    assert.equal(
      new Set(delivered.map((m) => m.messageId)).size,
      7,
      "Concurrent workers claim each row once",
    );
    assert(delivered.every((m) => m.disableFileAccess && m.disableUrlAccess));
    await deliverEmailBatch({ send: sender, limit: 10 });
    assert.equal(
      delivered.length,
      7,
      "Already accepted messages are not re-sent",
    );
    // Fresh payment event: transient SMTP errors retry later with a stable message ID.
    const retryInv = { ...inv, id: randomUUID(), number: "INV-EMAIL-RETRY" };
    await transaction((q) => queuePaymentCompleted(q, retryInv, "stripe"));
    const attemptIds = [];
    const failed = await deliverEmailBatch({
      limit: 1,
      send: async (m) => {
        attemptIds.push(m.messageId);
        throw Object.assign(
          new Error(
            "Secret credentials and SMTP response must never be logged",
          ),
          { code: "EAUTH", responseCode: 535 },
        );
      },
    });
    assert.equal(failed.failed, 1);
    let pending = (
      await pool.query(
        "SELECT * FROM legalflow.email_outbox WHERE last_error IS NOT NULL",
      )
    ).rows[0];
    assert.equal(pending.state, "pending");
    assert.equal(pending.last_error, "EAUTH (535)");
    assert(pending.next_attempt_at > new Date());
    await pool.query(
      "UPDATE legalflow.email_outbox SET next_attempt_at=now()-interval '1 second',created_at=now()-interval '1 day' WHERE id=$1",
      [pending.id],
    );
    await deliverEmailBatch({
      limit: 1,
      send: async (m) => {
        attemptIds.push(m.messageId);
        return { accepted: [m.to], rejected: [] };
      },
    });
    assert.equal(attemptIds[0], attemptIds[1]);
    assert.equal(
      (
        await pool.query(
          "SELECT state FROM legalflow.email_outbox WHERE id=$1",
          [pending.id],
        )
      ).rows[0].state,
      "sent",
    );
    // An interrupted worker's old lease can be recovered; leases have unique fencing tokens.
    const stale = (
      await pool.query(
        "SELECT id FROM legalflow.email_outbox WHERE state='pending' LIMIT 1",
      )
    ).rows[0];
    await pool.query(
      "UPDATE legalflow.email_outbox SET state='sending',leased_at=now()-interval '11 minutes',lease_token='old-lease',created_at=now()-interval '2 days' WHERE id=$1",
      [stale.id],
    );
    assert.equal((await deliverEmailBatch({ limit: 1, send: sender })).sent, 1);
    const permanent = (
      await pool.query(
        "SELECT id FROM legalflow.email_outbox WHERE state='pending' LIMIT 1",
      )
    ).rows[0];
    await pool.query(
      "UPDATE legalflow.email_outbox SET created_at=now()-interval '3 days' WHERE id=$1",
      [permanent.id],
    );
    await deliverEmailBatch({
      limit: 1,
      send: async () => {
        throw Object.assign(new Error("Recipient unknown"), {
          code: "EENVELOPE",
          responseCode: 550,
        });
      },
    });
    assert.equal(
      (
        await pool.query(
          "SELECT state FROM legalflow.email_outbox WHERE id=$1",
          [permanent.id],
        )
      ).rows[0].state,
      "failed",
    );
    assert.equal(
      safeMailError({
        code: "EAUTH",
        message: "private password",
        response: "private reply",
        responseCode: 535,
      }),
      "EAUTH (535)",
    );
    assert.equal(
      (await deliverEmailBatch()).sent,
      0,
      "Disabled SMTP must not attempt a real connection",
    );
  } finally {
    await pool.end();
    await socket.stop();
    await db.close();
  }
});
