import { permissionKeys } from "./role-profiles.js";
export { permissionKeys } from "./role-profiles.js";
import { assert } from "../utils/errors.js";
export const internal = (u) => u && u.role !== "customer";
export const owner = (u) =>
  assert(u?.role === "owner", 403, "Only the owner can manage this resource");
export function effectivePermissions(u) {
  if (!u) return {};
  if (
    u.role === "owner" &&
    (!u.role_profile || u.role_profile === "super_admin")
  )
    return Object.fromEntries(permissionKeys.map((k) => [k, true]));
  if (u.role === "customer") return {};
  const legacy = {
    "cases.view": true,
    "cases.details": true,
    "cases.financials": true,
    "cases.import": true,
    "files.view": true,
    "files.legal": true,
    "files.upload": true,
    "files.edit": true,
    "files.delete": true,
    "files.approve": u.role === "manager",
    "reports.export": true,
    "email.use": true,
    "chat.use": true,
    "calendar.manage": true,
    "team.assign": u.role === "manager",
    "invoices.send":
      (u.permissions?.["invoices.create"] ??
        u.role_permissions?.["invoices.create"]) === true ||
      (u.permissions?.["invoices.edit"] ??
        u.role_permissions?.["invoices.edit"]) === true,
    "payments.record":
      (u.permissions?.["invoices.edit"] ??
        u.role_permissions?.["invoices.edit"]) === true,
  };
  return Object.fromEntries(
    permissionKeys.map((k) => [
      k,
      (u.permissions?.[k] ??
        u.role_permissions?.[k] ??
        (!u.role_profile ? legacy[k] : false)) === true,
    ]),
  );
}
export const isSuper = (u) =>
  u?.role === "owner" && (!u.role_profile || u.role_profile === "super_admin");
export const can = (u, key) =>
  u?.status === "Active" && effectivePermissions(u)[key] === true;
export const permit = (u, key) =>
  assert(
    can(u, key),
    403,
    "Your account does not have permission to " + key.replace(".", " "),
  );
export const biller = (u) =>
  assert(
    ["invoices.create", "invoices.edit", "invoices.send"].some((k) =>
      can(u, k),
    ),
    403,
    "Invoice permission required",
  );
export const teamIds = (c) => [
  ...new Set(
    [c?.staff_id, c?.manager_id, ...(c?.data?.teamMemberIds || [])].filter(
      Boolean,
    ),
  ),
];
export const visible = (u, c) =>
  !!c &&
  (u?.role === "customer" || can(u, "cases.view")) &&
  u?.status === "Active" &&
  (can(u, "cases.view_all") ||
    (u.role === "customer"
      ? c.client_id === u.client_id &&
        ((u.customer_access || "all") === "all" ||
          (u.workspace_ids || []).includes(c.workspace_id))
      : ["manager", "staff"].includes(u.role) && teamIds(c).includes(u.id)));
export const canMessage = (a, b, cases) =>
  !!a &&
  !!b &&
  (!a.role_profile || a.role === "customer" || can(a, "chat.use")) &&
  (!b.role_profile || b.role === "customer" || can(b, "chat.use")) &&
  a.id !== b.id &&
  a.status === "Active" &&
  b.status === "Active" &&
  (a.role === "owner" ||
    b.role === "owner" ||
    (internal(a) && internal(b)) ||
    cases.some((c) => {
      const customer = a.role === "customer" ? a : b;
      const staff = customer === a ? b : a;
      return (
        internal(staff) && visible(customer, c) && teamIds(c).includes(staff.id)
      );
    }));
export function caseScope(u, alias = "c") {
  if (u.role !== "customer" && !can(u, "cases.view"))
    return { sql: "FALSE", values: [] };
  if (can(u, "cases.view_all")) return { sql: "TRUE", values: [] };
  if (u.role === "customer")
    return {
      sql: `${alias}.client_id=$1 AND ($2::boolean OR ${alias}.workspace_id=ANY($3::text[]))`,
      values: [
        u.client_id,
        (u.customer_access || "all") === "all",
        u.workspace_ids || [],
      ],
    };
  return {
    sql: `(${alias}.${u.role === "manager" ? "manager_id" : "staff_id"}=$1 OR COALESCE(${alias}.data->'teamMemberIds','[]'::jsonb) ? $1)`,
    values: [u.id],
  };
}
