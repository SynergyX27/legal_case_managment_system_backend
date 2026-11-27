import { can, permit, isSuper } from "../services/access.service.js";
export function permissionPolicy(req, res, next) {
  const p = req.path,
    m = req.method,
    u = req.user;
  if (isSuper(u) || u.role === "customer") return next();
  let key;
  if (p.startsWith("/permissions/")) key = "permissions.manage";
  else if (p.startsWith("/users")) key = "users.manage";
  else if (
    p.startsWith("/integrations/") ||
    p.includes("/integrations/") ||
    ["/email/status", "/email/verify", "/email/retry"].includes(p) ||
    p.startsWith("/email/incoming/")
  )
    key = "settings.manage";
  else if (p.startsWith("/custom-fields")) key = "settings.manage";
  else if (p.startsWith("/company/profile") && m !== "GET")
    key = "company.manage";
  else if (
    p === "/workspace-access" ||
    ((p.startsWith("/workspaces") || /^\/cases\/[^/]+\/workspace$/.test(p)) &&
      m !== "GET")
  )
    key = "workspaces.manage";
  else if (p.startsWith("/email/")) key = "email.use";
  else if (p.startsWith("/conversations") && !p.endsWith("/read"))
    key = "chat.use";
  else if (p.startsWith("/events/")) key = "calendar.manage";
  else if (p.startsWith("/cases/import/")) key = "cases.import";
  else if (p === "/cases/team") key = "team.assign";
  else if (p.startsWith("/file-manager/collections/")) key = "company.manage";
  else if (p.startsWith("/file-manager/review-queue")) key = "files.approve";
  else if (p.startsWith("/file-manager") && m === "GET") key = "files.view";
  else if (p === "/file-manager/files")
    key = ["approve", "reject"].includes(req.body?.action)
      ? "files.approve"
      : "files.edit";
  else if (p.startsWith("/documents/") && m === "GET") key = "files.view";
  else if (p.startsWith("/documents/") && m === "DELETE") key = "files.delete";
  else if (p === "/documents" && m === "POST") key = "files.upload";
  else if (p.includes("/report") || p.startsWith("/reports/")) {
    key = "reports.export";
    permit(u, "cases.details");
    permit(u, "cases.financials");
  } else if (/^\/invoices\/[^/]+\/(email|public-link|public-links)$/.test(p))
    key = "invoices.send";
  else if (
    p.includes("/invoices/pdf") ||
    /^\/invoices\/[^/]+\/pdf$/.test(p) ||
    p === "/invoice-picker"
  ) {
    if (
      ![
        "invoices.view",
        "invoices.create",
        "invoices.edit",
        "payments.record",
      ].some((k) => can(u, k))
    )
      permit(u, "invoices.view");
  }
  if (key) permit(u, key);
  next();
}
