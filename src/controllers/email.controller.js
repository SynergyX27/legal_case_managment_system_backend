import { env } from "../config/env.js";
import { pool, transaction } from "../config/database.js";
import { owner } from "../services/access.service.js";
import { smtpTransport, safeMailError } from "../services/email.service.js";
import { audit } from "../models/audit.model.js";
import { HttpError } from "../utils/errors.js";
export async function emailStatus(req, res) {
  owner(req.user);
  const rows = (
    await pool.query(
      "SELECT state,count(*)::int AS count FROM legalflow.email_outbox GROUP BY state",
    )
  ).rows;
  res.json({
    enabled: env.SMTP_ENABLED,
    from: env.MAIL_FROM,
    counts: Object.fromEntries(
      ["pending", "sending", "sent", "failed"].map((state) => [
        state,
        rows.find((r) => r.state === state)?.count || 0,
      ]),
    ),
    lastError:
      (
        await pool.query(
          "SELECT last_error FROM legalflow.email_outbox WHERE last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0]?.last_error || null,
  });
}
export async function verifyEmail(req, res) {
  owner(req.user);
  if (!env.SMTP_ENABLED)
    throw new HttpError(422, "Enable SMTP in the backend environment first");
  try {
    await smtpTransport().verify();
    res.json({ ok: true });
  } catch (error) {
    throw new HttpError(
      502,
      `SMTP connection failed: ${safeMailError(error)}. Check the backend environment and hosting SMTP access`,
    );
  }
}
export async function retryEmails(req, res) {
  owner(req.user);
  const count = await transaction(async (db) => {
    const result = await db.query(
      "UPDATE legalflow.email_outbox SET state='pending',attempts=0,last_error=NULL,next_attempt_at=now(),lease_token=NULL,leased_at=NULL WHERE state='failed'",
    );
    await audit(db, req.user, "email.failed-retried", null);
    return result.rowCount;
  });
  res.json({ ok: true, count });
}
