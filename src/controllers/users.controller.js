import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { owner } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { audit } from "../models/audit.model.js";
import { createUserRecord } from "./auth.controller.js";
import { hashPassword } from "../services/password.service.js";
import * as schema from "../validators/schemas.js";
export async function createUser(req, res) {
  owner(req.user);
  const u = await createUserRecord(req.body, req.user);
  res.status(201).json({ id: u.id });
}
export async function updateUser(req, res) {
  owner(req.user);
  const id = schema.id.parse(req.params.id);
  const v = schema.accessInput.parse(req.body);
  const hash = v.password ? await hashPassword(v.password) : null;
  await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    const old = await findUser(id, db);
    assert(old, 404, "User not found");
    assert(
      id !== req.user.id || (v.role === "owner" && v.status === "Active"),
      422,
      "You cannot remove your own owner access",
    );
    assert(
      (old.role === "customer") === (v.role === "customer"),
      422,
      "Customer and team accounts cannot be converted",
    );
    if (old.role !== v.role)
      assert(
        !(
          await db.query(
            "SELECT 1 FROM legalflow.cases WHERE staff_id=$1 OR manager_id=$1",
            [id],
          )
        ).rowCount,
        409,
        "Reassign this team member’s cases before changing their role",
      );
    if (old.role === "owner" && (v.role !== "owner" || v.status !== "Active"))
      assert(
        (
          await db.query(
            "SELECT 1 FROM legalflow.users WHERE role='owner' AND status='Active' AND id<>$1",
            [id],
          )
        ).rowCount,
        422,
        "Keep at least one active owner",
      );
    await db.query(
      "UPDATE legalflow.users SET role=$2,status=$3,password_hash=COALESCE($4,password_hash),updated_at=now() WHERE id=$1",
      [id, v.role, v.status, hash],
    );
    await db.query("DELETE FROM legalflow.sessions WHERE sess->>'userId'=$1", [
      id,
    ]);
    await audit(db, req.user, "user.access-updated", id);
  });
  res.json({ ok: true });
}
