export const reportKeys = [
  "community",
  "neighborhood",
  "plaintiff",
  "county",
  "city",
  "state",
];
export function selectReportCases(cases, filters = {}, userId = "") {
  const lower = (v) =>
    String(v || "")
      .trim()
      .toLowerCase();
  const query = lower(filters.search);
  return cases.filter(
    (c) =>
      reportKeys.every(
        (key) => !filters[key] || lower(c[key]) === lower(filters[key]),
      ) &&
      (!filters.status?.length || filters.status.includes(c.status)) &&
      (!filters.clientId || c.clientId === filters.clientId) &&
      (!filters.staffId || c.staffId === filters.staffId) &&
      (!filters.type || c.type === filters.type) &&
      (!filters.dateFrom || c.serviceDate >= filters.dateFrom) &&
      (!filters.dateTo || c.serviceDate <= filters.dateTo) &&
      (!filters.mine || c.staffId === userId || c.managerId === userId) &&
      (!query ||
        [
          c.searchCustomer,
          c.type,
          c.visLO,
          c.visTO,
          c.locs,
          c.lbx,
          c.number,
          c.ref,
          c.title,
          c.residentName,
          c.residentAddress,
          c.community,
          c.neighborhood,
          c.plaintiff,
          c.county,
          c.city,
          c.state,
          c.zip,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
}
export function caseMoney(cases) {
  const owed = cases.reduce(
    (sum, c) => sum + Math.round(Number(c.moneyOwed || 0) * 100),
    0,
  );
  const cleared = cases
    .filter((c) => c.status === "Completed")
    .reduce((sum, c) => sum + Math.round(Number(c.moneyOwed || 0) * 100), 0);
  return {
    owed: owed / 100,
    cleared: cleared / 100,
    due: (owed - cleared) / 100,
  };
}
export const escapeHtml = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function caseReportHtml(cases, filters, statuses) {
  const money = (n) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(n);
  const totals = caseMoney(cases);
  const criteria =
    Object.entries(filters)
      .filter(([, v]) => (Array.isArray(v) ? v.length : !!v))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(" · ") || "All accessible cases";
  return `<h1>Case files report</h1><p>${escapeHtml(criteria)}</p><p>${cases.length} cases · Generated ${escapeHtml(new Date().toISOString())}</p><p>Amount owed ${money(totals.owed)} · Amount cleared ${money(totals.cleared)} · Amount due ${money(totals.due)}</p><p>${statuses.map((status) => escapeHtml(status) + ": " + (status === "All cases" ? cases.length : cases.filter((c) => c.status === status).length)).join(" · ")}</p><table border="1" cellpadding="6" cellspacing="0"><thead><tr>${["Case number", "Community", "Neighborhood", "Plaintiff", "Tenant", "Address", "County", "City", "State", "Status", "Money owed", "Amount cleared", "Amount due"].map((h) => "<th>" + h + "</th>").join("")}</tr></thead><tbody>${cases.map((c) => "<tr>" + [c.number, c.community, c.neighborhood, c.plaintiff, c.residentName, c.residentAddress, c.county, c.city, c.state, c.status, money(Number(c.moneyOwed || 0)), money(c.status === "Completed" ? Number(c.moneyOwed || 0) : 0), money(c.status === "Completed" ? 0 : Number(c.moneyOwed || 0))].map((v) => "<td>" + escapeHtml(v) + "</td>").join("") + "</tr>").join("")}</tbody></table>`;
}
