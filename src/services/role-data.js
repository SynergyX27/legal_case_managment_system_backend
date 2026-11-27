import { can } from "./access.service.js";
export function redactCase(u, c) {
  if (!u.role_profile || u.role === "customer") return c;
  const out = { ...c };
  if (!can(u, "cases.financials"))
    for (const k of [
      "moneyOwed",
      "originalBalance",
      "amountCleared",
      "balanceOwed",
      "monthlyRent",
      "lastPaymentDate",
      "fee",
      "paid",
      "owed",
      "originalAmount",
      "paidAmount",
      "balance",
      "invoiceTotal",
      "paidToDate",
      "paidInvoiceTotal",
    ])
      delete out[k];
  if (!can(u, "cases.details"))
    for (const k of [
      "notes",
      "court",
      "plaintiff",
      "attorney",
      "description",
      "custom",
      "comments",
      "ref",
      "refCl",
      "residentPhone",
    ])
      delete out[k];
  if (!can(u, "cases.details")) {
    out.custom = {};
    out.comments = [];
  }
  return out;
}
