import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const address = (value) => {
  const parsed = z
    .string()
    .email()
    .max(254)
    .safeParse(
      String(value ?? "")
        .trim()
        .toLowerCase(),
    );
  return parsed.success ? parsed.data : null;
};
const money = (invoice) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Math.round(
      invoice.lines.reduce((n, l) => n + l.qty * l.price, 0) *
        (1 + invoice.taxRate / 100) *
        100,
    ) / 100,
  );
export function emailTemplate({ name, title, description, details, url }) {
  const greeting = `Hello ${name || "there"},`;
  const text = [
    greeting,
    "",
    title,
    description,
    "",
    ...details.map(([k, v]) => `${k}: ${v}`),
    "",
    `Open LegalFlow: ${url}`,
    "",
    "Sign in to view the full details. This is an automated notification.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6fb;font-family:Arial,sans-serif;color:#182b49"><div style="max-width:580px;margin:24px auto;background:white;border:1px solid #dce4ef;border-radius:16px;overflow:hidden"><div style="padding:22px 28px;background:#2d5795;color:white;font-size:22px;font-weight:bold">LegalFlow</div><div style="padding:28px"><p>${escape(greeting)}</p><h1 style="font-size:23px">${escape(title)}</h1><p style="line-height:1.6">${escape(description)}</p><table style="width:100%;border-collapse:collapse">${details.map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e8edf4;color:#65758b">${escape(k)}</td><td style="padding:10px 0;border-bottom:1px solid #e8edf4;text-align:right">${escape(v)}</td></tr>`).join("")}</table><p style="margin:28px 0"><a href="${escape(url)}" style="background:#2d5795;color:white;padding:13px 20px;border-radius:8px;text-decoration:none">Open LegalFlow</a></p><p style="color:#65758b;font-size:12px">Sign in to view full details. This is an automated notification.</p></div></div></body></html>`;
  return { text, html };
}
async function enqueue(db, eventKey, recipient, content) {
  const email = address(recipient.email);
  if (!email) return;
  const body = emailTemplate({ ...content, name: recipient.name });
  await db.query(
    "INSERT INTO legalflow.email_outbox(id,event_key,to_email,subject,text_body,html_body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key,to_email) DO NOTHING",
    [randomUUID(), eventKey, email, content.title, body.text, body.html],
  );
}
async function client(db, id) {
  return (
    await db.query("SELECT data FROM legalflow.clients WHERE id=$1", [id])
  ).rows[0]?.data;
}
export async function queueCaseOpened(db, c) {
  const recipient = await client(db, c.clientId);
  if (!recipient) return;
  await enqueue(db, `case.created:${c.id}`, recipient, {
    title: `Case ${c.number} opened`,
    description:
      "Your case has been opened. You can view its progress, documents and messages in your customer portal.",
    details: [
      ["Case", c.number],
      ["Status", c.status],
    ],
    url: new URL(`/cases/${encodeURIComponent(c.id)}`, env.APP_ORIGIN).href,
  });
}
export async function queueInvoiceIssued(db, invoice) {
  const recipient = await client(db, invoice.clientId);
  if (!recipient) return;
  await enqueue(db, `invoice.issued:${invoice.id}`, recipient, {
    title: `Invoice ${invoice.number} issued`,
    description:
      "A new invoice is available for your case. Sign in to view the invoice and available payment options.",
    details: [
      ["Invoice", invoice.number],
      ["Total", money(invoice)],
      ["Due date", invoice.dueDate],
    ],
    url: new URL(
      `/invoices?caseId=${encodeURIComponent(invoice.caseId)}`,
      env.APP_ORIGIN,
    ).href,
  });
}
export async function queuePaymentCompleted(db, invoice, method) {
  const c = (
    await db.query(
      "SELECT number,staff_id,manager_id FROM legalflow.cases WHERE id=$1",
      [invoice.caseId],
    )
  ).rows[0];
  const recipient = await client(db, invoice.clientId);
  const details = [
    ["Invoice", invoice.number],
    ["Case", c?.number || ""],
    ["Amount paid", money(invoice)],
    [
      "Payment",
      method === "stripe"
        ? "Online payment confirmed"
        : "Payment recorded by your case team",
    ],
    ["Status", "Paid"],
  ];
  const url = new URL(
    `/invoices?caseId=${encodeURIComponent(invoice.caseId)}`,
    env.APP_ORIGIN,
  ).href;
  if (recipient)
    await enqueue(db, `invoice.paid:${invoice.id}`, recipient, {
      title: `Payment received for ${invoice.number}`,
      description:
        "Your invoice is now marked paid. Thank you for your payment.",
      details,
      url,
    });
  const team = (
    await db.query(
      "SELECT name,email FROM legalflow.users WHERE status='Active' AND (role='owner' OR id=$1 OR id=$2)",
      [c?.staff_id || null, c?.manager_id || null],
    )
  ).rows;
  for (const person of team)
    await enqueue(db, `invoice.paid:${invoice.id}`, person, {
      title: `Payment received for ${invoice.number}`,
      description:
        "Payment has been completed for an invoice on your case. The invoice status is now Paid.",
      details,
      url,
    });
}
