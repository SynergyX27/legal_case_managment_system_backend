import { assert } from "../utils/errors.js";
export const internal = (u) => u && u.role !== "customer";
export const owner = (u) =>
  assert(u?.role === "owner", 403, "Only the owner can manage this resource");
export const permissionKeys = [
  "cases.create",
  "cases.edit",
  "cases.delete",
  "invoices.view",
  "invoices.create",
  "invoices.edit",
  "invoices.delete",
];
export function effectivePermissions(u) {
  if (u?.role === "owner")
    return Object.fromEntries(permissionKeys.map((k) => [k, true]));
  if (!["manager", "staff"].includes(u?.role)) return {};
  return Object.fromEntries(
    permissionKeys.map((k) => [
      k,
      (u.permissions?.[k] ?? u.role_permissions?.[k]) === true,
    ]),
  );
}
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
    ["invoices.create", "invoices.edit"].some((k) => can(u, k)),
    403,
    "Invoice permission required",
  );
export const visible = (u, c) =>
  u?.status === "Active" &&
  (u.role === "owner" ||
    (u.role === "customer"
      ? c.client_id === u.client_id
      : u.role === "manager"
        ? c.manager_id === u.id
        : c.staff_id === u.id));
export const canMessage = (a, b, cases) =>
  !!a &&
  !!b &&
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
        internal(staff) &&
        c.client_id === customer.client_id &&
        (c.staff_id === staff.id || c.manager_id === staff.id)
      );
    }));
export function caseScope(u, alias = "c") {
  if (u.role === "owner") return { sql: "TRUE", values: [] };
  return {
    sql: `${alias}.${u.role === "customer" ? "client_id" : u.role === "manager" ? "manager_id" : "staff_id"}=$1`,
    values: [u.role === "customer" ? u.client_id : u.id],
  };
}
