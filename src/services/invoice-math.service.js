// Integer cents are shared by checkout, reports, PDFs and case allocations.
export const invoiceCaseIds = (i) =>
  [...new Set([i.caseId, ...(i.caseIds || [])].filter(Boolean))].sort();
export function invoiceTotals(i) {
  if (
    (i.pricingVersion === 1 || (!i.pricingVersion && !i.caseIds)) &&
    !i.discount
  ) {
    const raw = i.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const base = Math.round(raw * 100),
      total = Math.round(raw * (1 + (i.taxRate || 0) / 100) * 100);
    return { base, discount: 0, net: base, tax: total - base, total };
  }
  const base = i.lines.reduce(
    (s, l) => s + Math.round(l.qty * l.price * 100),
    0,
  );
  const discount = Math.round((i.discount || 0) * 100);
  const net = base - discount;
  const tax = Math.round((net * (i.taxRate || 0)) / 100);
  return { base, discount, net, tax, total: net + tax };
}
export function invoiceAllocations(i) {
  const ids = invoiceCaseIds(i),
    t = invoiceTotals(i);
  if (ids.length === 1) return { [ids[0]]: t.total };
  const weights = ids.map((id) =>
    i.lines.reduce(
      (s, l) =>
        s +
        ((l.caseId || i.caseId) === id ? Math.round(l.qty * l.price * 100) : 0),
      0,
    ),
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return Object.fromEntries(ids.map((id) => [id, 0]));
  const numerator = weights.map((w) => BigInt(t.total) * BigInt(w));
  const parts = numerator.map((n) => Number(n / BigInt(sum)));
  // Largest remainder, deterministic by case ID, guarantees exact cent conservation.
  const order = ids
    .map((_, n) => n)
    .sort(
      (a, b) =>
        Number((numerator[b] % BigInt(sum)) - (numerator[a] % BigInt(sum))) ||
        a - b,
    );
  let remainder = t.total - parts.reduce((a, b) => a + b, 0);
  for (let n = 0; n < remainder; n++) parts[order[n]]++;
  return Object.fromEntries(ids.map((id, n) => [id, parts[n]]));
}
