import { assert } from "../utils/errors.js";
export const internal = (u) => u && u.role !== "customer";
export const owner = (u) =>
  assert(u?.role === "owner", 403, "Only the owner can manage this resource");
export const biller = (u) =>
  assert(
    ["owner", "manager"].includes(u?.role),
    403,
    "Billing requires owner or manager access",
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
