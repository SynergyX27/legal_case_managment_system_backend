import { HttpError } from "../utils/errors.js";
import { createHash, randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { fileTypeFromBuffer } from "file-type";
import { pool, transaction } from "../config/database.js";
import { env } from "../config/env.js";
import { findUser } from "../models/user.model.js";
import { visible } from "./access.service.js";
import { emailMimeTypes } from "./email-conversations.service.js";
import { uploadEmailFile } from "./dropbox.service.js";
import { notify } from "../models/audit.model.js";
export const mailboxKey = () =>
  createHash("sha256")
    .update(env.IMAP_HOST + ":" + env.IMAP_USER.toLowerCase())
    .digest("hex");
const safeError = (e) =>
  String(e?.code || e?.responseStatus || e?.name || "IMAP_ERROR")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 60) || "IMAP_ERROR";
// Gmail's top Authentication-Results header is supplied by its receiving server.
export function authenticatedSender(mail) {
  const h =
    mail.headerLines?.find((h) => h.key === "authentication-results")?.line ||
    "";
  return (
    /^Authentication-Results:\s*mx\.google\.com\s*;/i.test(h) &&
    /\bdmarc=pass\b/i.test(h)
  );
}
export async function ingestIncoming(
  mail,
  { requireAuthentication = true, dbClient = null } = {},
) {
  if (requireAuthentication && !authenticatedSender(mail))
    return { ignored: true, reason: "sender_authentication" };
  const from = mail.from?.value;
  if (from?.length !== 1) return { ignored: true };
  const sender = String(from[0].address || "").toLowerCase();
  const recipientAddresses = [
    ...(mail.to?.value || []),
    ...(mail.cc?.value || []),
  ].map((x) => String(x.address || "").toLowerCase());
  if (
    ![env.MAIL_FROM.toLowerCase(), env.IMAP_USER.toLowerCase()].some((a) =>
      recipientAddresses.includes(a),
    )
  )
    return { ignored: true };
  const refs = [
    mail.inReplyTo,
    ...(Array.isArray(mail.references) ? mail.references : [mail.references]),
  ]
    .filter((x) => typeof x === "string" && x.length < 1000)
    .slice(-40);
  if (!refs.length || !mail.messageId || mail.messageId.length > 998)
    return { ignored: true };
  const execute = async (db) => {
    const match = (
      await db.query(
        "SELECT t.*,u.email FROM legalflow.email_messages m JOIN legalflow.email_threads t ON t.id=m.thread_id JOIN legalflow.users u ON u.id=t.customer_user_id WHERE m.message_id=ANY($1::text[]) AND lower(u.email)=$2 AND u.status='Active' ORDER BY m.created_at DESC LIMIT 1",
        [refs, sender],
      )
    ).rows[0];
    if (!match) return { ignored: true };
    const customer = await findUser(match.customer_user_id, db),
      c = (
        await db.query("SELECT * FROM legalflow.cases WHERE id=$1", [
          match.case_id,
        ])
      ).rows[0];
    if (!visible(customer, c)) return { ignored: true };
    const body =
      String(mail.text || "")
        .trim()
        .slice(0, 50000) || "(Email has no plain-text message.)";
    const id = randomUUID();
    const inserted = await db.query(
      "INSERT INTO legalflow.email_messages(id,thread_id,direction,channel,sender_id,from_email,to_email,body,message_id) VALUES($1,$2,'incoming','email',$3,$4,$5,$6,$7) ON CONFLICT(message_id) DO NOTHING RETURNING id",
      [id, match.id, customer.id, sender, env.MAIL_FROM, body, mail.messageId],
    );
    if (!inserted.rowCount) return { duplicate: true };
    let total = 0,
      omitted = 0,
      count = 0;
    for (const a of mail.attachments || []) {
      total += a.content.length;
      let mime = (await fileTypeFromBuffer(a.content).catch(() => null))?.mime;
      const name = String(a.filename || "attachment")
        .replace(/[\x00-\x1f\x7f/\\]/g, "_")
        .slice(0, 200);
      if (!mime && /\.(txt|csv)$/i.test(name) && !a.content.includes(0))
        mime = /\.csv$/i.test(name) ? "text/csv" : "text/plain";
      if (
        !emailMimeTypes.has(mime) ||
        a.content.length > 5 * 1024 * 1024 ||
        total > 10 * 1024 * 1024 ||
        count >= 5
      ) {
        omitted++;
        continue;
      }
      count++;
      const aid = randomUUID();
      await db.query(
        "INSERT INTO legalflow.email_attachments(id,message_id,name,mime,bytes,payload,dropbox_path) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          aid,
          id,
          name,
          mime,
          a.content.length,
          a.content,
          `${env.DROPBOX_ROOT}/email/${id}/${aid}`,
        ],
      );
    }
    if (omitted)
      await db.query(
        "UPDATE legalflow.email_messages SET body=body||$2 WHERE id=$1",
        [
          id,
          `\n\n[${omitted} attachment(s) were not imported because of file type or size limits. Check the company mailbox.]`,
        ],
      );
    await db.query(
      "UPDATE legalflow.email_threads SET updated_at=now() WHERE id=$1",
      [match.id],
    );
    const owners = (
      await db.query(
        "SELECT id FROM legalflow.users WHERE role='owner' AND status='Active'",
      )
    ).rows.map((u) => u.id);
    await notify(
      db,
      [...new Set([...owners, c.staff_id, c.manager_id, ...(c.data?.teamMemberIds || [])].filter(Boolean))],
      "message",
      "A customer replied by email",
      "/email",
    );
    return { imported: true };
  };
  if (!dbClient) return transaction(execute);
  await dbClient.query("BEGIN");
  try {
    const result = await execute(dbClient);
    await dbClient.query("COMMIT");
    return result;
  } catch (e) {
    await dbClient.query("ROLLBACK");
    throw e;
  }
}
async function saveAttachments(db, upload = uploadEmailFile) {
  const rows = (
    await db.query(
      "SELECT * FROM legalflow.email_attachments WHERE state='pending' AND attempts<8 AND created_at + (least(attempts,6)*interval '1 minute')<=now() ORDER BY created_at LIMIT 5",
    )
  ).rows;
  for (const a of rows) {
    try {
      await upload(a.dropbox_path, a.payload);
      await db.query(
        "UPDATE legalflow.email_attachments SET state='ready',payload=NULL,last_error=NULL WHERE id=$1",
        [a.id],
      );
    } catch (e) {
      await db.query(
        "UPDATE legalflow.email_attachments SET attempts=attempts+1,last_error=$2 WHERE id=$1",
        [a.id, safeError(e)],
      );
    }
  }
}
export async function pollIncomingEmail({
  clientFactory = (options) => new ImapFlow(options),
  uploadAttachment = uploadEmailFile,
} = {}) {
  const db = await pool.connect();
  let client,
    locked = false;
  const key = mailboxKey();
  try {
    locked = (
      await db.query(
        "SELECT pg_try_advisory_lock(hashtext('legalflow-email-incoming')) AS acquired",
      )
    ).rows[0].acquired;
    if (!locked) return { busy: true };
    await saveAttachments(db, uploadAttachment);
    if (!env.IMAP_ENABLED) return { enabled: false };
    await db.query(
      "INSERT INTO legalflow.email_sync_state(id) VALUES($1) ON CONFLICT DO NOTHING",
      [key],
    );
    client = clientFactory({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      secure: true,
      auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    client.on("error", () => {});
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
    const state = (
        await db.query("SELECT * FROM legalflow.email_sync_state WHERE id=$1", [
          key,
        ])
      ).rows[0],
      validity = String(mailbox.uidValidity);
    if (!state.uid_validity || state.uid_validity !== validity) {
      await db.query(
        "UPDATE legalflow.email_sync_state SET uid_validity=$2,last_uid=$3,last_sync_at=now(),last_error=NULL WHERE id=$1",
        [key, validity, Math.max(0, mailbox.uidNext - 1)],
      );
      return { initialized: true, imported: 0 };
    }
    const last = Number(state.last_uid);
    const uids = (
      (await client.search({ uid: `${last + 1}:*` }, { uid: true })) || []
    )
      .filter((uid) => uid > last)
      .sort((a, b) => a - b)
      .slice(0, 25);
    let imported = 0,
      ignored = 0;
    for (const uid of uids) {
      const meta = await client.fetchOne(
        String(uid),
        { size: true },
        { uid: true },
      );
      if (!meta) continue;
      if (meta.size > 15 * 1024 * 1024) {
        ignored++;
      } else {
        const message = await client.fetchOne(
          String(uid),
          { source: true },
          { uid: true },
        );
        if (message?.source) {
          const parsed = await simpleParser(message.source, {
            skipHtmlToText: false,
            skipTextToHtml: true,
            maxHtmlLengthToParse: 2000000,
          }).catch(() => null);
          if (!parsed) {
            ignored++;
          } else {
            const result = await ingestIncoming(parsed, { dbClient: db });
            if (result.imported) imported++;
            else if (result.ignored) ignored++;
          }
        }
      }
      await db.query(
        "UPDATE legalflow.email_sync_state SET last_uid=$2 WHERE id=$1",
        [key, uid],
      );
    }
    await db.query(
      "UPDATE legalflow.email_sync_state SET last_sync_at=now(),last_error=NULL,ignored=ignored+$2 WHERE id=$1",
      [key, ignored],
    );
    await saveAttachments(db, uploadAttachment);
    return { imported, ignored };
  } catch (e) {
    await db
      .query(
        "INSERT INTO legalflow.email_sync_state(id,last_error) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET last_error=$2",
        [key, safeError(e)],
      )
      .catch(() => {});
    throw new HttpError(
      502,
      "Incoming email sync failed. Check IMAP settings in Render and retry.",
    );
  } finally {
    if (client) await client.logout().catch(() => client.close());
    if (locked)
      await db.query(
        "SELECT pg_advisory_unlock(hashtext('legalflow-email-incoming'))",
      );
    db.release();
  }
}
export function startIncomingEmailWorker() {
  let active = null,
    stopped = false;
  const tick = () => {
    if (active || stopped) return;
    active = pollIncomingEmail()
      .catch(() => {})
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, env.IMAP_POLL_SECONDS * 1000);
  timer.unref();
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (active) await active;
    },
  };
}
