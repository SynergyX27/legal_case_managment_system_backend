import { z } from "zod";
import { randomUUID } from "node:crypto";
import { invoicePdf, invoiceForUser } from "../services/invoice-pdf.service.js";
import { invoiceCaseIds } from "../services/invoice-math.service.js";
import { accessibleCase } from "../models/case.model.js";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import { biller, visible } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { assert } from "../utils/errors.js";
export async function pdf(req, res) {
  const r = await invoicePdf(req.user, [req.params.id]);
  res
    .type("application/pdf")
    .set("Content-Disposition", `attachment; filename="${r.filename}"`)
    .send(r.buffer);
}
export async function bundle(req, res) {
  const caseId = z.string().min(1).max(150).parse(req.params.id);
  await accessibleCase(req.user, caseId);
  const rows = (
    await pool.query(
      "SELECT id FROM legalflow.invoices WHERE deleted_at IS NULL AND (case_id=$1 OR (data->'caseIds') ? $1) AND ($2::boolean OR data->>'status'<>'Draft') ORDER BY created_at",
      [caseId, req.user.role !== "customer"],
    )
  ).rows;
  assert(
    rows.length && rows.length <= 50,
    422,
    "Choose a case with 1 to 50 accessible invoices",
  );
  const r = await invoicePdf(
    req.user,
    rows.map((x) => x.id),
  );
  res
    .type("application/pdf")
    .set("Content-Disposition", `attachment; filename="${r.filename}"`)
    .send(r.buffer);
}
export async function email(req, res) {
  biller(req.user);
  assert(env.SMTP_ENABLED, 503, "Email delivery is disabled");
  const v = z
    .object({
      mode: z.enum(["invoice", "payment", "message"]),
      message: z.string().trim().max(4000).default(""),
    })
    .parse(req.body);
  const { invoice: i, customer } = await invoiceForUser(
    req.user,
    req.params.id,
  );
  assert(i.status !== "Draft", 409, "Publish the invoice before emailing it");
  if (v.mode === "payment")
    assert(
      ["Sent", "Overdue"].includes(i.status),
      409,
      "Only unpaid invoices can request payment",
    );
  if (v.mode === "message") assert(v.message, 422, "Enter an email message");
  const users = (
    await pool.query(
      "SELECT id FROM legalflow.users WHERE client_id=$1 AND lower(email)=lower($2) AND deleted_at IS NULL AND status='Active'",
      [i.clientId, customer.email || ""],
    )
  ).rows;
  assert(
    users.length,
    422,
    "The customer needs an active main login and valid email",
  );
  const recipient = await findUser(users[0].id);
  for (const id of invoiceCaseIds(i)) {
    const c = await accessibleCase(req.user, id);
    assert(
      visible(recipient, c),
      422,
      "Customer main login must have access to every included case before receiving this invoice",
    );
  }
  const url = new URL(
    `/invoices?invoiceId=${encodeURIComponent(i.id)}`,
    env.APP_ORIGIN,
  ).href;
  const text = [
    v.message ||
      (v.mode === "payment"
        ? "Please sign in to pay your invoice securely."
        : "Your invoice is attached."),
    "",
    `Invoice: ${i.number}`,
    url,
    "Sign in to LegalFlow to view and pay.",
  ].join("\n");
  const attachments = [];
  if (v.mode === "invoice") {
    const r = await invoicePdf(req.user, [i.id]);
    assert(
      r.buffer.length < 12 * 1024 * 1024,
      422,
      "Invoice is too large to email",
    );
    attachments.push({
      filename: r.filename,
      content: r.buffer.toString("base64"),
      contentType: "application/pdf",
    });
  }
  await pool.query(
    "INSERT INTO legalflow.email_outbox(id,event_key,to_email,subject,text_body,html_body,attachments) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [
      randomUUID(),
      "invoice.delivery:" + randomUUID(),
      z.string().email().parse(customer.email),
      `Invoice ${i.number}`,
      text,
      "<p>" +
        text
          .replace(
            /[&<>"']/g,
            (c) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[c],
          )
          .replaceAll("\n", "<br>") +
        "</p>",
      JSON.stringify(attachments),
    ],
  );
  res.json({ ok: true });
}
