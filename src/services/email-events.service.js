import { issueInvoiceLink } from "./public-invoice.service.js";
import {
  invoiceTotals,
  invoiceCaseIds,
  invoiceAllocations,
} from "./invoice-math.service.js";
import { findUser } from "../models/user.model.js";
import { visible } from "./access.service.js";
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
    invoiceTotals(invoice).total / 100,
  );
const contentNote = (url) =>
  url.includes("/pay/invoice")
    ? "This private link opens your invoice without sign-in. Do not share it publicly."
    : "Sign in to view the full details. This is an automated notification.";
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
    contentNote(url),
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6fb;font-family:Arial,sans-serif;color:#182b49"><div style="max-width:580px;margin:24px auto;background:white;border:1px solid #dce4ef;border-radius:16px;overflow:hidden"><div style="padding:22px 28px;background:#2d5795;color:white;font-size:22px;font-weight:bold">LegalFlow</div><div style="padding:28px"><p>${escape(greeting)}</p><h1 style="font-size:23px">${escape(title)}</h1><p style="line-height:1.6">${escape(description)}</p><table style="width:100%;border-collapse:collapse">${details.map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e8edf4;color:#65758b">${escape(k)}</td><td style="padding:10px 0;border-bottom:1px solid #e8edf4;text-align:right">${escape(v)}</td></tr>`).join("")}</table><p style="margin:28px 0"><a href="${escape(url)}" style="background:#2d5795;color:white;padding:13px 20px;border-radius:8px;text-decoration:none">${url.includes("/pay/invoice") ? "View invoice" : "Open LegalFlow"}</a></p><p style="color:#65758b;font-size:12px">${escape(contentNote(url))}</p></div></div></body></html>`;
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
async function client(db, id, caseId) {
  const data = (
    await db.query("SELECT data FROM legalflow.clients WHERE id=$1", [id])
  ).rows[0]?.data;
  if (!data) return null;
  const rows = (
    await db.query(
      "SELECT id FROM legalflow.users WHERE client_id=$1 AND lower(email)=lower($2)",
      [id, data.email || ""],
    )
  ).rows;
  if (rows.length && caseId) {
    const u = await findUser(rows[0].id, db),
      c = (
        await db.query("SELECT * FROM legalflow.cases WHERE id=$1", [caseId])
      ).rows[0];
    if (!visible(u, c)) return null;
  }
  return data;
}
export async function queueCaseOpened(db, c) {
  const recipient = await client(db, c.clientId, c.id);
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
  const recipient = await client(db, invoice.clientId, invoice.caseId);
  if (!recipient || !(await clientCanSeeInvoice(db, invoice))) return;
  await enqueue(db, `invoice.issued:${invoice.id}`, recipient, {
    title: `Invoice ${invoice.number} issued`,
    description:
      "A new invoice is ready. Open your private link to view, download or pay online without signing in.",
    details: [
      ["Invoice", invoice.number],
      ["Total", money(invoice)],
      ["Due date", invoice.dueDate],
    ],
    url: (await issueInvoiceLink(db, invoice.id)).url,
  });
}
export async function queuePaymentCompleted(db, invoice, method) {
  const c = (
    await db.query(
      "SELECT number,staff_id,manager_id FROM legalflow.cases WHERE id=$1",
      [invoice.caseId],
    )
  ).rows[0];
  const recipient = await client(db, invoice.clientId, invoice.caseId);
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
  if (recipient && (await clientCanSeeInvoice(db, invoice)))
    await enqueue(db, `invoice.paid:${invoice.id}`, recipient, {
      title: `Payment received for ${invoice.number}`,
      description:
        "Your invoice is now marked paid. Thank you for your payment.",
      details,
      url: (await issueInvoiceLink(db, invoice.id)).url,
    });
  const team = (
    await db.query(
      "SELECT id,name,email FROM legalflow.users WHERE status='Active' AND deleted_at IS NULL AND (role='owner' OR id IN (SELECT staff_id FROM legalflow.cases WHERE id=ANY($1::text[]) UNION SELECT manager_id FROM legalflow.cases WHERE id=ANY($1::text[]) UNION SELECT jsonb_array_elements_text(COALESCE(data->'teamMemberIds','[]'::jsonb)) FROM legalflow.cases WHERE id=ANY($1::text[])))",
      [invoiceCaseIds(invoice)],
    )
  ).rows;
  const linked = (
    await db.query("SELECT * FROM legalflow.cases WHERE id=ANY($1::text[])", [
      invoiceCaseIds(invoice),
    ])
  ).rows;
  const allocations = invoiceAllocations(invoice);
  for (const person of team) {
    const user = await findUser(person.id, db);
    const own = linked.filter((c) => visible(user, c));
    if (!own.length) continue;
    const scopedDetails = details.map(([key, value]) => [
      key,
      key === "Case"
        ? own.map((c) => c.number).join(", ")
        : key === "Amount paid"
          ? new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(
              own.reduce((sum, c) => sum + (allocations[c.id] || 0), 0) / 100,
            )
          : value,
    ]);
    await enqueue(db, `invoice.paid:${invoice.id}`, person, {
      title: `Payment received for ${invoice.number}`,
      description:
        "Payment has been completed for an invoice on your case. The invoice status is now Paid.",
      details: scopedDetails,
      url:
        own.length === linked.length
          ? url
          : new URL(`/cases/${encodeURIComponent(own[0].id)}`, env.APP_ORIGIN)
              .href,
    });
  }
}

async function clientCanSeeInvoice(db, invoice) {
  const ids = invoiceCaseIds(invoice);
  const c = (
    await db.query("SELECT data FROM legalflow.clients WHERE id=$1", [
      invoice.clientId,
    ])
  ).rows[0]?.data;
  const users = (
    await db.query(
      "SELECT id FROM legalflow.users WHERE client_id=$1 AND lower(email)=lower($2) AND deleted_at IS NULL",
      [invoice.clientId, c?.email || ""],
    )
  ).rows;
  if (!users.length) return false;
  const u = await findUser(users[0].id, db);
  for (const id of ids) {
    const row = (
      await db.query("SELECT * FROM legalflow.cases WHERE id=$1", [id])
    ).rows[0];
    if (!visible(u, row)) return false;
  }
  return true;
}
