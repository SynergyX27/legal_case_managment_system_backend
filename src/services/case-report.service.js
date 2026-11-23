import { caseAmounts } from "./case-balance.service.js";
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
          c.refId,
          c.attorney,
          c.unit,
          c.visRI,
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
  return cases.reduce(
    (totals, c) => {
      const balance = caseAmounts(c);
      return {
        owed: Math.round((totals.owed + balance.original) * 100) / 100,
        cleared: Math.round((totals.cleared + balance.cleared) * 100) / 100,
        due: Math.round((totals.due + balance.due) * 100) / 100,
      };
    },
    { owed: 0, cleared: 0, due: 0 },
  );
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
  const totalPaid =
    cases.reduce((sum, c) => sum + Math.round(caseAmounts(c).paid * 100), 0) /
    100;
  const criteria =
    Object.entries(filters)
      .filter(([, v]) => (Array.isArray(v) ? v.length : !!v))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join(" · ") || "All accessible cases";
  return `<h1>Case files report</h1><p>${escapeHtml(criteria)}</p><p>${cases.length} cases · Generated ${escapeHtml(new Date().toISOString())}</p><p>Original amount ${money(totals.owed)} · Paid amount ${money(totalPaid)} · Owed amount ${money(totals.due)}</p><p>${statuses.map((status) => escapeHtml(status) + ": " + (status === "All cases" ? cases.length : cases.filter((c) => c.status === status).length)).join(" · ")}</p>${cases.some((c) => c.status === "Completed") ? "<p>Completed cases are treated as fully cleared. Paid amount shows recorded invoice payments.</p>" : ""}<table border="1" cellpadding="6" cellspacing="0"><thead><tr>${["Case number", "REF CL#", "REF ID#", "Attorney", "Property type", "Suite / Unit #", "SF", "Monthly rent", "Last rental payment date", "VIS - RI", "Community", "Neighborhood", "Plaintiff", "Tenant", "Address", "County", "City", "State", "Status", "Original amount", "Paid amount", "Owed amount"].map((h) => "<th>" + h + "</th>").join("")}</tr></thead><tbody>${cases.map((c) => "<tr>" + [c.number, c.ref, c.refId, c.attorney, c.propertyType, c.unit, c.squareFeet, c.monthlyRent == null ? "" : money(c.monthlyRent), c.lastPaymentDate, c.visRI, c.community, c.neighborhood, c.plaintiff, c.residentName, c.residentAddress, c.county, c.city, c.state, c.status, money(caseAmounts(c).original), money(caseAmounts(c).paid), money(caseAmounts(c).due)].map((v) => "<td>" + escapeHtml(v) + "</td>").join("") + "</tr>").join("")}</tbody></table>`;
}
