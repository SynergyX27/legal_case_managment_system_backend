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
    const actor = await findUser(req.user.id, db);
    assert(
      actor?.role === "owner" && actor.status === "Active",
      403,
      "Owner access required",
    );
    const old = await findUser(id, db);
    assert(old, 404, "User not found");
    assert(
      v.updatedAt &&
        new Date(v.updatedAt).getTime() === old.updated_at.getTime(),
      409,
      "User changed on another device. Reopen access before saving",
    );
    const email = v.email ?? old.email;
    const phone = v.phone ?? old.phone;
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.users WHERE lower(email)=lower($1) AND id<>$2",
          [email, id],
        )
      ).rowCount,
      409,
      "Another account already uses this email address",
    );
    const managerId =
      v.role === "staff" ? (v.managerId ?? old.manager_id ?? "") : null;
    if (v.role === "staff") {
      assert(managerId, 422, "Assign this staff member to a manager");
      assert(
        (
          await db.query(
            "SELECT 1 FROM legalflow.users WHERE id=$1 AND role='manager' AND status='Active'",
            [managerId],
          )
        ).rowCount,
        422,
        "Select an active manager",
      );
    }
    if (
      old.role === "manager" &&
      (v.role !== "manager" || v.status !== "Active")
    ) {
      assert(
        !(
          await db.query(
            "SELECT 1 FROM legalflow.users WHERE manager_id=$1 UNION ALL SELECT 1 FROM legalflow.cases WHERE manager_id=$1 OR COALESCE(data->'teamMemberIds','[]'::jsonb) ? $1",
            [id],
          )
        ).rowCount,
        409,
        "Reassign this manager’s staff and cases before changing their role or deactivating them",
      );
    }
    assert(
      !v.permissions || ["staff", "manager"].includes(v.role),
      422,
      "Only manager and staff permissions can be customized",
    );
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
            "SELECT 1 FROM legalflow.cases WHERE staff_id=$1 OR manager_id=$1 OR COALESCE(data->'teamMemberIds','[]'::jsonb) ? $1",
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
      "UPDATE legalflow.users SET role=$2,status=$3,password_hash=COALESCE($4,password_hash),manager_id=$5,permissions=$6,email=$7,phone=$8,updated_at=now() WHERE id=$1",
      [
        id,
        v.role,
        v.status,
        hash,
        managerId,
        ["staff", "manager"].includes(v.role)
          ? (v.permissions ?? old.permissions)
          : {},
        email,
        phone,
      ],
    );
    // A sole customer login is also the company contact. Multiple logins retain
    // separate personal contact details; edit the company contact in Customers.
    if (old.client_id && (v.email !== undefined || v.phone !== undefined)) {
      await db.query(
        "SELECT id FROM legalflow.clients WHERE id=$1 FOR UPDATE",
        [old.client_id],
      );
      if (
        (
          await db.query(
            "SELECT id FROM legalflow.users WHERE client_id=$1 AND deleted_at IS NULL",
            [old.client_id],
          )
        ).rowCount === 1
      )
        await db.query(
          "UPDATE legalflow.clients SET data=data || jsonb_build_object('email',$2::text,'phone',$3::text) WHERE id=$1",
          [old.client_id, email, phone],
        );
      else
        await db.query(
          "UPDATE legalflow.clients SET data=data || CASE WHEN lower(data->>'email')=lower($2) THEN jsonb_build_object('email',$3::text,'phone',$4::text) ELSE '{}'::jsonb END WHERE id=$1",
          [old.client_id, old.email, email, phone],
        );
    }
    if (v.role === "staff" && managerId !== old.manager_id) {
      // Move existing cases with the staff member, preserving the required team relationship.
      await db.query(
        "UPDATE legalflow.cases SET manager_id=$2,data=jsonb_set(data,'{managerId}',to_jsonb($2::text)),updated_at=now() WHERE staff_id=$1",
        [id, managerId],
      );
      await audit(db, req.user, "staff.manager-assigned", id);
    }
    if (hash || old.role !== v.role || old.status !== v.status)
      await db.query("DELETE FROM legalflow.mobile_sessions WHERE user_id=$1", [
        id,
      ]);
    if (hash || old.role !== v.role || old.status !== v.status)
      await db.query(
        "DELETE FROM legalflow.sessions WHERE sess->>'userId'=$1",
        [id],
      );
    await audit(db, req.user, "user.access-updated", id);
  });
  res.json({ ok: true });
}

export async function deleteUser(req, res) {
  owner(req.user);
  const id = schema.id.parse(req.params.id);
  const version = schema.accessInput.shape.updatedAt.parse(req.body?.updatedAt);
  await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    const actor = await findUser(req.user.id, db);
    assert(
      actor?.role === "owner" && actor.status === "Active",
      403,
      "Owner access required",
    );
    const old = await findUser(id, db);
    assert(old, 404, "User not found");
    if (old.client_id) {
      const client = (
        await db.query("SELECT * FROM legalflow.clients WHERE id=$1", [
          old.client_id,
        ])
      ).rows[0];
      const { primaryLogin } = await import("./clients.controller.js");
      assert(
        (await primaryLogin(db, client))?.id !== id,
        409,
        "Manage or delete the main customer account from Customers. Additional logins are managed in Workspaces",
      );
    }
    assert(id !== actor.id, 422, "You cannot delete your own account");
    // Prevent concurrent assignments while checking and deleting this login.
    await db.query("SELECT id FROM legalflow.users WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    assert(
      version && new Date(version).getTime() === old.updated_at.getTime(),
      409,
      "User changed on another device. Reopen their details before deleting",
    );
    if (old.role === "owner" && old.status === "Active")
      assert(
        (
          await db.query(
            "SELECT 1 FROM legalflow.users WHERE role='owner' AND status='Active' AND deleted_at IS NULL AND id<>$1",
            [id],
          )
        ).rowCount,
        409,
        "Keep at least one active owner",
      );
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.cases WHERE staff_id=$1 OR manager_id=$1 OR COALESCE(data->'teamMemberIds','[]'::jsonb) ? $1 OR ($2::text IS NOT NULL AND client_id=$2) LIMIT 1",
          [id, old.client_id],
        )
      ).rowCount,
      409,
      "This user has assigned cases. Reassign or remove those cases before deleting the account. Customer logins are linked through their customer company",
    );
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.users WHERE manager_id=$1 AND deleted_at IS NULL LIMIT 1",
          [id],
        )
      ).rowCount,
      409,
      "Reassign this manager's staff before deleting their account",
    );
    await db.query(
      "UPDATE legalflow.users SET status='Inactive',deleted_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
    await db.query("DELETE FROM legalflow.sessions WHERE sess->>'userId'=$1", [
      id,
    ]);
    await db.query("DELETE FROM legalflow.mobile_sessions WHERE user_id=$1", [
      id,
    ]);
    await db.query("DELETE FROM legalflow.workspace_members WHERE user_id=$1", [
      id,
    ]);
    await db.query("DELETE FROM legalflow.notifications WHERE user_id=$1", [
      id,
    ]);
    await audit(db, actor, "user.deleted", id);
  });
  res.json({ ok: true });
}
