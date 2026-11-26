import { randomBytes, createHash } from "node:crypto";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import { assert } from "../utils/errors.js";
export const publicTokenHash = (t) =>
  createHash("sha256").update(t).digest("hex");
export async function issueInvoiceLink(db, invoiceId, createdBy = null) {
  const token = randomBytes(32).toString("base64url");
  const row = (
    await db.query(
      "INSERT INTO legalflow.invoice_public_links(token_hash,invoice_id,created_by,expires_at) VALUES($1,$2,$3,now()+interval '90 days') RETURNING expires_at",
      [publicTokenHash(token), invoiceId, createdBy],
    )
  ).rows[0];
  const url = new URL("/pay/invoice", env.APP_ORIGIN);
  url.hash = new URLSearchParams({ token }).toString();
  return { url: url.href, expiresAt: row.expires_at.toISOString() };
}
export async function publicInvoice(token, db = pool) {
  const row = (
    await db.query(
      "SELECT i.* FROM legalflow.invoice_public_links l JOIN legalflow.invoices i ON i.id=l.invoice_id WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND l.expires_at>now() AND i.deleted_at IS NULL AND i.data->>'status' IN ('Sent','Overdue','Paid')",
      [publicTokenHash(token)],
    )
  ).rows[0];
  assert(
    row,
    404,
    "This invoice link is unavailable or has expired. Please request a new link from your case team.",
  );
  return row;
}
export async function publicInvoiceRecord(row, db = pool) {
  const customer =
    (
      await db.query("SELECT data FROM legalflow.clients WHERE id=$1", [
        row.client_id,
      ])
    ).rows[0]?.data || {};
  // This capability grants invoice access only. Never expose case records, documents or notes.
  let snapshots = row.data.caseSnapshots;
  if (!snapshots) {
    const c = (
      await db.query("SELECT number,data FROM legalflow.cases WHERE id=$1", [
        row.case_id,
      ])
    ).rows[0];
    snapshots = c
      ? [
          {
            id: row.case_id,
            number: c.number,
            refId: c.data.refId,
            tenant: c.data.residentName,
            address: c.data.residentAddress,
            unit: c.data.unit,
            serviceDate: c.data.serviceDate,
            community: c.data.community,
          },
        ]
      : [];
  }
  return {
    invoice: {
      ...row.data,
      id: row.id,
      number: row.number,
      caseId: row.case_id,
      clientId: row.client_id,
      caseSnapshots: snapshots,
    },
    customer,
    cases: [],
  };
}
