import { z } from "zod";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool } from "../config/database.js";
import { caseScope, owner } from "../services/access.service.js";
import {
  authorizeEmail,
  sendConversation,
} from "../services/email-conversations.service.js";
import { downloadFile } from "../services/dropbox.service.js";
import { assert } from "../utils/errors.js";
import { env } from "../config/env.js";
import {
  pollIncomingEmail,
  mailboxKey,
} from "../services/incoming-email.service.js";
export async function list(req, res) {
  const scope = caseScope(req.user);
  const values = [
    ...scope.values,
    req.user.role === "customer" ? req.user.id : "",
    req.user.id,
  ];
  const customerParam = scope.values.length + 1,
    readParam = scope.values.length + 2;
  const rows = (
    await pool.query(
      `SELECT t.*,c.number,cl.data->>'name' AS company_name,u.name AS customer_name,(SELECT count(*)::int FROM legalflow.email_messages m WHERE m.thread_id=t.id AND m.sender_id IS DISTINCT FROM $${readParam} AND m.created_at>coalesce((SELECT last_read_at FROM legalflow.email_reads r WHERE r.thread_id=t.id AND r.user_id=$${readParam}),'epoch'::timestamptz)) AS unread FROM legalflow.email_threads t JOIN legalflow.cases c ON c.id=t.case_id JOIN legalflow.clients cl ON cl.id=c.client_id JOIN legalflow.users u ON u.id=t.customer_user_id WHERE (${scope.sql}) AND ($${customerParam}='' OR t.customer_user_id=$${customerParam}) ORDER BY t.updated_at DESC LIMIT 500`,
      values,
    )
  ).rows;
  res.json({
    threads: rows.map((r) => ({
      id: r.id,
      caseId: r.case_id,
      caseNumber: r.number,
      customerUserId: r.customer_user_id,
      customerName: r.customer_name,
      subject: r.subject,
      updatedAt: r.updated_at.toISOString(),
      unread: r.unread,
    })),
    configured: env.SMTP_ENABLED,
  });
}
export async function messages(req, res) {
  const t = await authorizeEmail(req.user, req.params.id);
  const cursor = z.string().max(100).optional().parse(req.query.before);
  let before = null;
  if (cursor) {
    const row = (
      await pool.query(
        "SELECT created_at,id FROM legalflow.email_messages WHERE id=$1 AND thread_id=$2",
        [cursor, t.id],
      )
    ).rows[0];
    assert(row, 422, "Invalid message cursor");
    before = row;
  }
  const rows = (
    await pool.query(
      "SELECT m.*,o.state AS delivery_state,o.last_error FROM legalflow.email_messages m LEFT JOIN legalflow.email_outbox o ON o.id=m.outbox_id WHERE m.thread_id=$1 AND ($2::timestamptz IS NULL OR (m.created_at,m.id)<($2,$3)) ORDER BY m.created_at DESC,m.id DESC LIMIT 51",
      [t.id, before?.created_at || null, before?.id || ""],
    )
  ).rows;
  const more = rows.length > 50,
    page = rows.slice(0, 50);
  const attachments = (
    await pool.query(
      "SELECT id,message_id,name,mime,bytes,state FROM legalflow.email_attachments WHERE message_id=ANY($1::text[])",
      [page.map((m) => m.id)],
    )
  ).rows;
  res.json({
    thread: {
      id: t.id,
      caseId: t.case_id,
      customerUserId: t.customer_user_id,
      subject: t.subject,
    },
    messages: page.reverse().map((m) => ({
      id: m.id,
      direction: m.direction,
      channel: m.channel,
      senderId: m.sender_id,
      from: m.from_email,
      to: m.to_email,
      text: m.body,
      at: m.created_at.toISOString(),
      deliveryState: m.delivery_state || "received",
      error: m.last_error || "",
      attachments: attachments
        .filter((a) => a.message_id === m.id)
        .map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          bytes: a.bytes,
          state: a.state,
        })),
    })),
    nextBefore: more ? page[0].id : null,
  });
}
export async function send(req, res) {
  const v = z
    .object({
      threadId: z.string().uuid().optional(),
      caseId: z.string().max(100).optional(),
      customerUserId: z.string().max(100).optional(),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((s) => !/[\r\n]/.test(s)),
      text: z.string().trim().min(1).max(50000),
      requestId: z.string().uuid(),
      attachmentIds: z.array(z.string().max(100)).max(5).default([]),
    })
    .parse(req.body);
  assert(
    v.threadId || (v.caseId && v.customerUserId),
    422,
    "Choose a case and registered customer",
  );
  res.status(201).json(await sendConversation(req.user, v));
}
export async function read(req, res) {
  await authorizeEmail(req.user, req.params.id);
  await pool.query(
    "INSERT INTO legalflow.email_reads(thread_id,user_id) VALUES($1,$2) ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_at=now()",
    [req.params.id, req.user.id],
  );
  res.json({ ok: true });
}
export async function attachment(req, res) {
  const a = (
    await pool.query(
      "SELECT a.*,m.thread_id FROM legalflow.email_attachments a JOIN legalflow.email_messages m ON m.id=a.message_id WHERE a.id=$1",
      [req.params.id],
    )
  ).rows[0];
  assert(a, 404, "Attachment not found");
  await authorizeEmail(req.user, a.thread_id);
  assert(
    a.state === "ready",
    409,
    "Attachment is being saved to Dropbox. Try again shortly.",
  );
  res.type(a.mime);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  await pipeline(Readable.fromWeb(await downloadFile(a.dropbox_path)), res);
}
export async function status(req, res) {
  owner(req.user);
  const row = (
    await pool.query(
      "SELECT last_sync_at,last_error,ignored FROM legalflow.email_sync_state WHERE id=$1",
      [mailboxKey()],
    )
  ).rows[0];
  res.json({
    enabled: env.IMAP_ENABLED,
    configured: !!(env.IMAP_USER && env.IMAP_PASSWORD),
    host: env.IMAP_HOST,
    lastSync: row?.last_sync_at || null,
    lastError: row?.last_error || null,
    ignored: row?.ignored || 0,
    pendingAttachments: (
      await pool.query(
        "SELECT count(*)::int AS n FROM legalflow.email_attachments WHERE state='pending'",
      )
    ).rows[0].n,
  });
}
export async function sync(req, res) {
  owner(req.user);
  assert(env.IMAP_ENABLED, 422, "Enable IMAP in the backend environment first");
  res.json(await pollIncomingEmail());
}
export async function recipients(req, res) {
  const caseId = z.string().max(100).parse(req.query.caseId);
  const c = await (
    await import("../models/case.model.js")
  ).accessibleCase(req.user, caseId);
  const { findUser } = await import("../models/user.model.js");
  const { visible } = await import("../services/access.service.js");
  const ids = (
    await pool.query(
      "SELECT id FROM legalflow.users WHERE client_id=$1 AND role='customer' AND status='Active'",
      [c.client_id],
    )
  ).rows;
  const users = await Promise.all(ids.map((u) => findUser(u.id)));
  res.json({
    recipients: users
      .filter(
        (u) =>
          visible(u, c) &&
          (req.user.role !== "customer" || u.id === req.user.id),
      )
      .map((u) => ({ id: u.id, name: u.name, email: u.email })),
  });
}

export async function retryAttachments(req, res) {
  owner(req.user);
  await pool.query(
    "UPDATE legalflow.email_attachments SET attempts=0,last_error=NULL WHERE state='pending'",
  );
  res.json({ ok: true });
}
