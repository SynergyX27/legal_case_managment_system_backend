import { invoiceAllocations } from "./invoice-math.service.js";
// Derive balances from paid invoice records so webhook retries cannot deduct twice.
export function paidTotalsByCase(invoices) {
  const totals = new Map();
  for (const row of invoices) {
    const invoice = row.data || row;
    if (row.deleted_at || invoice.status !== "Paid") continue;
    for (const [id, cents] of Object.entries(
      invoiceAllocations({ ...invoice, caseId: row.case_id || invoice.caseId }),
    ))
      totals.set(id, (totals.get(id) || 0) + cents);
  }
  return new Map([...totals].map(([id, cents]) => [id, cents / 100]));
}
export function caseAmounts(c) {
  const original = Math.max(0, Math.round(Number(c.moneyOwed || 0) * 100));
  const paid = Math.max(0, Math.round(Number(c.paidInvoiceTotal || 0) * 100));
  const cleared =
    c.status === "Completed" ? original : Math.min(original, paid);
  return {
    original: original / 100,
    paid: paid / 100,
    cleared: cleared / 100,
    due: (original - cleared) / 100,
  };
}
export async function casePaidTotals(db, ids) {
  if (!ids.length) return new Map();
  const invoices = (
    await db.query(
      "SELECT case_id,data FROM legalflow.invoices WHERE deleted_at IS NULL AND (case_id=ANY($1::text[]) OR (data->'caseIds') ?| $1::text[]) AND data->>'status'='Paid'",
      [ids],
    )
  ).rows;
  return paidTotalsByCase(invoices);
}

export async function withCaseBalances(db, rows) {
  const totals = await casePaidTotals(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const data = { ...row.data, paidInvoiceTotal: totals.get(row.id) || 0 };
    return { ...row, data: { ...data, balanceOwed: caseAmounts(data).due } };
  });
}
