import { z } from "zod";
import { owner } from "../services/access.service.js";
import { transaction } from "../config/database.js";
import { permissionsInput } from "../validators/schemas.js";
import { assert } from "../utils/errors.js";
import { audit } from "../models/audit.model.js";
export async function updatePermissions(req, res) {
  owner(req.user);
  const role = z.enum(["manager", "staff"]).parse(req.params.role);
  const v = z
    .object({ permissions: permissionsInput, updatedAt: z.string() })
    .parse(req.body);
  await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    const old = (
      await db.query(
        "SELECT * FROM legalflow.role_permissions WHERE role=$1 FOR UPDATE",
        [role],
      )
    ).rows[0];
    assert(
      old.updated_at.getTime() === new Date(v.updatedAt).getTime(),
      409,
      "Permissions changed on another device. Reload before saving",
    );
    await db.query(
      "UPDATE legalflow.role_permissions SET permissions=$2,updated_at=now() WHERE role=$1",
      [role, v.permissions],
    );
    await audit(db, req.user, "permissions.updated", role);
  });
  res.json({ ok: true });
}
