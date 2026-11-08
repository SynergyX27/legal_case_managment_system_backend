import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { pool, transaction } from "../config/database.js";
let transport;
export function smtpTransport() {
  if (!env.SMTP_ENABLED) throw new Error("SMTP email is disabled");
  return (transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 45000,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  }));
}
export function safeMailError(error) {
  // Never persist SMTP responses, credentials, recipient addresses or full error objects.
  const code =
    String(error?.code || "SMTP_ERROR")
      .replace(/[^A-Z0-9_]/g, "")
      .slice(0, 40) || "SMTP_ERROR";
  const response = Number(error?.responseCode);
  return (
    code +
    (Number.isInteger(response) && response >= 400 && response <= 599
      ? ` (${response})`
      : "")
  );
}
async function claim() {
  return transaction(async (db) => {
    const row = (
      await db.query(
        "SELECT * FROM legalflow.email_outbox WHERE (state='pending' AND next_attempt_at<=now()) OR (state='sending' AND leased_at<now()-interval '10 minutes') ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!row) return null;
    const token = randomUUID();
    await db.query(
      "UPDATE legalflow.email_outbox SET state='sending',attempts=attempts+1,lease_token=$2,leased_at=now() WHERE id=$1",
      [row.id, token],
    );
    return { ...row, attempts: row.attempts + 1, lease_token: token };
  });
}
export async function deliverEmailBatch({ send, limit = 5 } = {}) {
  if (!send && !env.SMTP_ENABLED) return { sent: 0, failed: 0 };
  const sender = send || ((message) => smtpTransport().sendMail(message));
  let sent = 0,
    failed = 0;
  for (let n = 0; n < limit; n++) {
    const row = await claim();
    if (!row) break;
    try {
      const result = await sender({
        from: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM },
        to: row.to_email,
        subject: row.subject,
        text: row.text_body,
        html: row.html_body,
        messageId: `<legalflow-${row.id}@${(env.MAIL_FROM || "notifications@legalflow.invalid").split("@").at(-1)}>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (result?.rejected?.length)
        throw Object.assign(new Error("Recipient rejected"), {
          code: "EENVELOPE",
          responseCode: 550,
        });
      await pool.query(
        "UPDATE legalflow.email_outbox SET state='sent',sent_at=now(),last_error=NULL,lease_token=NULL,leased_at=NULL WHERE id=$1 AND lease_token=$2",
        [row.id, row.lease_token],
      );
      sent++;
    } catch (error) {
      const code = safeMailError(error),
        permanent =
          error?.code === "EENVELOPE" && Number(error?.responseCode) >= 500;
      const exhausted = row.attempts >= 8 || permanent;
      const delay = Math.min(
        6 * 3600,
        60 * 2 ** Math.min(row.attempts - 1, 12),
      );
      await pool.query(
        "UPDATE legalflow.email_outbox SET state=$3,last_error=$4,next_attempt_at=now()+$5*interval '1 second',lease_token=NULL,leased_at=NULL WHERE id=$1 AND lease_token=$2",
        [
          row.id,
          row.lease_token,
          exhausted ? "failed" : "pending",
          code,
          delay,
        ],
      );
      console.error(
        JSON.stringify({
          operation: "email.delivery",
          id: row.id,
          code,
          attempt: row.attempts,
          state: exhausted ? "failed" : "pending",
        }),
      );
      failed++;
    }
  }
  return { sent, failed };
}
export function startEmailWorker() {
  let stopped = false,
    running = null;
  const tick = () => {
    if (stopped || running || !env.SMTP_ENABLED) return;
    running = deliverEmailBatch()
      .catch((error) =>
        console.error(
          JSON.stringify({
            operation: "email.worker",
            code: safeMailError(error),
          }),
        ),
      )
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, env.EMAIL_POLL_SECONDS * 1000);
  timer.unref();
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
      transport?.close();
    },
  };
}
