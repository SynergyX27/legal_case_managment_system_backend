import { roleProfiles, eligiblePermission } from "../services/role-profiles.js";
import { permit, isSuper } from "../services/access.service.js";
import { z } from "zod";
import { owner } from "../services/access.service.js";
import { transaction } from "../config/database.js";
import { permissionsInput } from "../validators/schemas.js";
import { assert } from "../utils/errors.js";
import { audit } from "../models/audit.model.js";
export async function updatePermissions(req, res) {
  assert(isSuper(req.user), 403, "Only Super Admin can change role defaults");
  const rawRole = z
    .enum([
      "manager",
      "staff",
      ...roleProfiles
        .filter((p) => p.id !== "super_admin")
        .map((p) => "profile_" + p.id),
    ])
    .parse(req.params.role);
  const role = rawRole.replace(/^profile_/, "");
  const table = !rawRole.startsWith("profile_")
    ? "role_permissions"
    : "role_profiles";
  const column = table === "role_profiles" ? "id" : "role";
  const v = z
    .object({ permissions: permissionsInput, updatedAt: z.string() })
    .parse(req.body);
  assert(
    v.permissions["permissions.manage"] !== true,
    422,
    "Permission administration is reserved for Super Admin",
  );
  const base = roleProfiles.find((p) => p.id === role)?.baseRole || role;
  assert(
    Object.entries(v.permissions).every(
      ([k, v]) => !v || eligiblePermission(base, k),
    ),
    422,
    "Permission is not available for this role type",
  );
  await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    const old = (
      await db.query(
        `SELECT * FROM legalflow.${table} WHERE ${column}=$1 FOR UPDATE`,
        [role],
      )
    ).rows[0];
    assert(old, 404, "Role preset not found");
    assert(
      old.updated_at.getTime() === new Date(v.updatedAt).getTime(),
      409,
      "Permissions changed on another device. Reload before saving",
    );
    await db.query(
      `UPDATE legalflow.${table} SET permissions=$2,updated_at=now() WHERE ${column}=$1`,
      [role, v.permissions],
    );
    await audit(db, req.user, "permissions.updated", role);
  });
  res.json({ ok: true });
}
