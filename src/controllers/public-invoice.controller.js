import { z } from "zod";
import { pool, transaction } from "../config/database.js";
import { env } from "../config/env.js";
import { assert } from "../utils/errors.js";
import { biller } from "../services/access.service.js";
import {
  invoiceForUser,
  renderInvoicePdf,
  invoiceFilename,
} from "../services/invoice-pdf.service.js";
import {
  issueInvoiceLink,
  publicInvoice,
  publicInvoiceRecord,
  publicTokenHash,
} from "../services/public-invoice.service.js";
import { invoiceTotals } from "../services/invoice-math.service.js";
import { profile } from "./company.controller.js";
import { image } from "../services/single-case-report.service.js";
import {
  createPublicCheckout,
  paymentStatus,
  paymentConfiguration,
} from "../services/payments.service.js";
const body = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export function privateResponse(req, res, next) {
  res.set({
    "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  next();
}
async function read(req) {
  const { token } = body.parse(req.body);
  return { token, row: await publicInvoice(token) };
}
export async function link(req, res) {
  biller(req.user);
  const { invoice } = await invoiceForUser(req.user, req.params.id);
  assert(
    invoice.status !== "Draft",
    409,
    "Publish this invoice before sharing a payment link",
  );
  res.json(await issueInvoiceLink(pool, invoice.id, req.user.id));
}
export async function revoke(req, res) {
  biller(req.user);
  await invoiceForUser(req.user, req.params.id);
  await transaction(async (db) => {
    await db.query("SELECT id FROM legalflow.invoices WHERE id=$1 FOR UPDATE", [
      req.params.id,
    ]);
    await db.query(
      "UPDATE legalflow.invoice_public_links SET revoked_at=now() WHERE invoice_id=$1 AND revoked_at IS NULL",
      [req.params.id],
    );
  });
  res.json({ ok: true });
}
export async function view(req, res) {
  const { row } = await read(req),
    r = await publicInvoiceRecord(row),
    p = await profile(),
    t = invoiceTotals(r.invoice);
  const i = r.invoice;
  res.json({
    invoice: {
      number: i.number,
      date: i.date,
      dueDate: i.dueDate,
      status: i.status,
      paidAt: i.paidAt,
      template: i.template || "T1",
      taxRate: i.taxRate,
      currency: "USD",
      lines: i.lines.map((l) => {
        const c =
          i.caseSnapshots.find((c) => c.id === (l.caseId || i.caseId)) || {};
        return {
          description: l.description,
          qty: l.qty,
          price: l.price,
          serviceOutcome: l.serviceOutcome || "",
          caseNumber: c.number,
          reference: c.refId,
          tenant: c.tenant,
          address: c.address,
          unit: c.unit,
          serviceDate: c.serviceDate,
        };
      }),
      totals: t,
    },
    company: {
      name: p.companyName,
      address: p.address,
      email: p.email,
      phone: p.phone,
      website: p.website,
      hasLogo: !!p.logoDocumentId,
    },
    customer: {
      name: r.customer.name,
      company: r.customer.company,
      address: r.customer.address,
      email: r.customer.email,
      phone: r.customer.phone,
    },
    payment: paymentConfiguration(),
  });
}
export async function logo(req, res) {
  const { row } = await read(req);
  const p = await profile();
  assert(p.logoDocumentId, 404, "No logo");
  const bytes = await image(p.logoDocumentId, null);
  const png = bytes[0] === 137;
  res.type(png ? "image/png" : "image/jpeg").send(bytes);
}
export async function pdf(req, res) {
  const { row } = await read(req),
    record = await publicInvoiceRecord(row);
  const buffer = await renderInvoicePdf([record], await profile());
  res
    .type("application/pdf")
    .set(
      "Content-Disposition",
      `attachment; filename="${invoiceFilename(record.invoice)}"`,
    )
    .send(buffer);
}
async function actor(row, token) {
  const customer = (
    await pool.query(
      "SELECT u.id,u.email FROM legalflow.users u JOIN legalflow.clients c ON c.id=u.client_id WHERE u.client_id=$1 AND u.role='customer' AND u.status='Active' AND u.deleted_at IS NULL ORDER BY (u.id=c.data->>'primaryUserId') DESC NULLS LAST,u.created_at LIMIT 1",
      [row.client_id],
    )
  ).rows[0];
  assert(
    customer,
    409,
    "Please contact the case team to enable payment for this invoice",
  );
  const url = new URL("/pay/invoice", env.APP_ORIGIN);
  url.hash = new URLSearchParams({ token }).toString();
  return {
    id: customer.id,
    email: customer.email,
    role: "customer",
    status: "Active",
    client_id: row.client_id,
    publicInvoiceId: row.id,
    publicTokenHash: publicTokenHash(token),
    publicReturnUrl: url.href,
  };
}
export async function checkout(req, res) {
  assert(
    req.headers.origin === new URL(env.APP_ORIGIN).origin,
    403,
    "Request origin is not allowed",
  );
  const { token, row } = await read(req);
  if (row.data.status === "Paid") return res.json({ paid: true });
  res.json(await createPublicCheckout(await actor(row, token), row.id));
}
export async function status(req, res) {
  const { token, row } = await read(req);
  if (row.data.status === "Paid") return res.json({ status: "Paid" });
  res.json(await paymentStatus(await actor(row, token), row.id));
}
