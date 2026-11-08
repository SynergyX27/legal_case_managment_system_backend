import { pool } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { visible } from "../services/access.service.js";
export async function accessibleCase(
  u,
  id,
  db = pool,
  { write = false, lock = false } = {},
) {
  const c = (
    await db.query(
      `SELECT * FROM legalflow.cases WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  assert(c && visible(u, c), 404, "Case not found");
  assert(!write || u.role !== "customer", 403, "Customers cannot change cases");
  return c;
}
export async function validateAssignments(c, u, db) {
  assert(
    c.staffId && c.managerId,
    422,
    "Every case requires a responsible staff member and manager",
  );
  const staff = (
    await db.query("SELECT * FROM legalflow.users WHERE id=$1", [c.staffId])
  ).rows[0];
  assert(
    staff?.manager_id === c.managerId,
    422,
    "Select the manager assigned to this staff member in People & access",
  );
  assert(
    (
      await db.query("SELECT 1 FROM legalflow.clients WHERE id=$1", [
        c.clientId,
      ])
    ).rowCount,
    422,
    "Select a valid customer",
  );
  for (const [id, role] of [
    [c.staffId, "staff"],
    [c.managerId, "manager"],
  ])
    if (id)
      assert(
        (
          await db.query(
            "SELECT 1 FROM legalflow.users WHERE id=$1 AND role=$2 AND status='Active'",
            [id, role],
          )
        ).rowCount,
        422,
        `Select an active ${role}`,
      );
  if (u.role === "manager")
    assert(
      c.managerId === u.id,
      403,
      "Managers must remain assigned to their cases",
    );
  if (u.role === "staff")
    assert(
      c.staffId === u.id,
      403,
      "Staff must remain assigned to their cases",
    );
}
