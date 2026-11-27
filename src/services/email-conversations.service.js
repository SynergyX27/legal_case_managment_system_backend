import { randomUUID, createHash } from "node:crypto";
import { pool, transaction } from "../config/database.js";
import { env } from "../config/env.js";
import { accessibleCase } from "../models/case.model.js";
import { findUser } from "../models/user.model.js";
import { visible } from "./access.service.js";
import { assert } from "../utils/errors.js";
import { downloadFile } from "./dropbox.service.js";
import { audit, notify } from "../models/audit.model.js";
export const emailMimeTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export async function authorizeEmail(user, id, db = pool) {
  const thread = (
    await db.query("SELECT * FROM legalflow.email_threads WHERE id=$1", [id])
  ).rows[0];
  assert(thread, 404, "Email conversation not found");
  await accessibleCase(user, thread.case_id, db);
  assert(
    user.role !== "customer" || thread.customer_user_id === user.id,
    404,
    "Email conversation not found",
  );
  return thread;
}
export async function emailAttachments(db, caseId, ids) {
  const result = [];
  let total = 0;
  for (const id of [...new Set(ids)]) {
    const d = (
      await db.query(
        "SELECT * FROM legalflow.documents WHERE id=$1 AND case_id=$2 AND state='ready'",
        [id, caseId],
      )
    ).rows[0];
    assert(
      d && emailMimeTypes.has(d.mime) && Number(d.bytes) <= 5 * 1024 * 1024,
      422,
      "Select case documents up to 5 MB each in a supported email format",
    );
    total += Number(d.bytes);
    assert(
      total <= 10 * 1024 * 1024,
      422,
      "Email attachments must total at most 10 MB",
    );
    const chunks = [];
    let size = 0;
    for await (const chunk of await downloadFile(d.dropbox_path)) {
      size += chunk.length;
      assert(size <= 5 * 1024 * 1024, 422, "Attachment too large");
      chunks.push(Buffer.from(chunk));
    }
    result.push({
      filename: d.name,
      content: Buffer.concat(chunks).toString("base64"),
      contentType: d.mime,
    });
  }
  return result;
}
export async function sendConversation(
  user,
  {
    threadId,
    caseId,
    customerUserId,
    subject,
    text,
    requestId,
    attachmentIds = [],
  },
) {
  assert(
    env.SMTP_ENABLED,
    503,
    "Email delivery is disabled. Configure SMTP before using email conversations.",
  );
  return transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    user = await findUser(user.id, db);
    assert(user?.status === "Active", 401, "Please sign in");
    let thread = threadId ? await authorizeEmail(user, threadId, db) : null;
    const c = await accessibleCase(user, thread?.case_id || caseId, db, {lock: true});
    const customer = await findUser(
      thread?.customer_user_id || customerUserId,
      db,
    );
    assert(
      customer?.role === "customer" && visible(customer, c),
      422,
      "Select an active registered customer with access to this case",
    );
    assert(
      user.role !== "customer" || customer.id === user.id,
      403,
      "Customers can only email their own case team",
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          threadId: threadId || "",
          caseId: caseId || "",
          customerUserId: customerUserId || "",
          subject,
          text,
          attachmentIds: [...attachmentIds].sort(),
        }),
      )
      .digest("hex");
    const existing = (
      await db.query(
        "SELECT m.* FROM legalflow.email_messages m JOIN legalflow.email_threads t ON t.id=m.thread_id WHERE m.id=$1 AND m.sender_id=$2",
        [requestId, user.id],
      )
    ).rows[0];
    if (existing) {
      assert(
        (!threadId || existing.thread_id === threadId) &&
          existing.body === text &&
          existing.request_fingerprint === fingerprint,
        409,
        "This email attempt was already used for different content",
      );
      await authorizeEmail(user, existing.thread_id, db);
      return { id: existing.thread_id, messageId: existing.id, reused: true };
    }
    const attachments = await emailAttachments(db, c.id, attachmentIds);
    if (!thread) {
      thread = {
        id: randomUUID(),
        case_id: c.id,
        customer_user_id: customer.id,
        subject,
      };
      await db.query(
        "INSERT INTO legalflow.email_threads(id,case_id,customer_user_id,subject,created_by) VALUES($1,$2,$3,$4,$5)",
        [thread.id, c.id, customer.id, subject, user.id],
      );
    }
    const previous = (
      await db.query(
        "SELECT message_id FROM legalflow.email_messages WHERE thread_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [thread.id],
      )
    ).rows[0]?.message_id;
    const domain = env.MAIL_FROM.split("@").at(-1),
      messageId = `<legalflow-conversation-${requestId}@${domain}>`,
      outboxId = randomUUID();
    const fromCustomer = user.role === "customer";
    const recipient = fromCustomer ? env.MAIL_FROM : customer.email;
    const body = fromCustomer
      ? `${customer.name} replied through LegalFlow.\n\n${text}\n\nOpen the case: ${env.APP_ORIGIN}/cases/${c.id}`
      : text;
    const headers = {
      messageId,
      ...(previous ? { inReplyTo: previous, references: [previous] } : {}),
      ...(fromCustomer ? { replyTo: customer.email } : {}),
    };
    await db.query(
      "INSERT INTO legalflow.email_outbox(id,event_key,to_email,subject,text_body,html_body,attachments,mail_headers) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        outboxId,
        "conversation:" + requestId,
        recipient,
        thread.subject,
        body,
        "",
        JSON.stringify(attachments),
        JSON.stringify(headers),
      ],
    );
    await db.query(
      "INSERT INTO legalflow.email_messages(id,thread_id,direction,channel,sender_id,from_email,to_email,body,message_id,outbox_id,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        requestId,
        thread.id,
        fromCustomer ? "incoming" : "outgoing",
        "portal",
        user.id,
        fromCustomer ? customer.email : env.MAIL_FROM,
        recipient,
        text,
        messageId,
        outboxId,
        fingerprint,
      ],
    );
    for (const a of attachments) {
      const aid = randomUUID(),
        content = Buffer.from(a.content, "base64");
      await db.query(
        "INSERT INTO legalflow.email_attachments(id,message_id,name,mime,bytes,payload,dropbox_path) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          aid,
          requestId,
          a.filename,
          a.contentType,
          content.length,
          content,
          `${env.DROPBOX_ROOT}/email/${requestId}/${aid}`,
        ],
      );
    }
    await db.query(
      "UPDATE legalflow.email_threads SET updated_at=now() WHERE id=$1",
      [thread.id],
    );
    await db.query(
      "INSERT INTO legalflow.email_reads(thread_id,user_id) VALUES($1,$2) ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_at=now()",
      [thread.id, user.id],
    );
    const recipients = fromCustomer
      ? [
          c.staff_id,
          c.manager_id,
          ...(c.data?.teamMemberIds || []),
          ...(
            await db.query(
              "SELECT id FROM legalflow.users WHERE role='owner' AND status='Active'",
            )
          ).rows.map((r) => r.id),
        ]
      : [customer.id];
    await notify(
      db,
      recipients.filter((id) => id !== user.id),
      "message",
      "New case email conversation message",
      "/email",
    );
    await audit(db, user, "email.conversation-sent", thread.id);
    return { id: thread.id, messageId: requestId };
  });
}
