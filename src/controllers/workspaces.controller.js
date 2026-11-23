import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "../config/database.js";
import { owner, caseScope } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { accessibleCase } from "../models/case.model.js";
import { assert } from "../utils/errors.js";
import { audit, activity } from "../models/audit.model.js";
import {
  withCaseBalances,
  caseAmounts,
} from "../services/case-balance.service.js";
async function lockOwner(req, db) {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
  );
  const fresh = await findUser(req.user.id, db);
  assert(fresh?.status === "Active", 401, "Please sign in");
  owner(fresh);
  req.user = fresh;
}
export async function list(req, res) {
  const scope = caseScope(req.user);
  const cases = await withCaseBalances(
    pool,
    (
      await pool.query(
        `SELECT c.* FROM legalflow.cases c WHERE ${scope.sql}`,
        scope.values,
      )
    ).rows,
  );
  const memberships = (
    await pool.query("SELECT * FROM legalflow.workspace_members")
  ).rows;
  const all = (
    await pool.query("SELECT * FROM legalflow.workspaces ORDER BY name")
  ).rows;
  const workspaceById = new Map(all.map((w) => [w.id, w]));
  const directlyAllowed = (w) =>
    req.user.role === "owner" ||
    (req.user.role === "customer" &&
      w.client_id === req.user.client_id &&
      ((req.user.customer_access || "all") === "all" ||
        (req.user.workspace_ids || []).includes(w.id))) ||
    memberships.some(
      (m) =>
        m.user_id === req.user.id &&
        (m.workspace_id === w.id || m.workspace_id === w.parent_id),
    ) ||
    cases.some((c) => c.workspace_id === w.id);
  const allowed = all.filter(
    (w) =>
      directlyAllowed(w) ||
      all.some((child) => child.parent_id === w.id && directlyAllowed(child)),
  );
  res.json({
    workspaces: allowed.map((w) => {
      const rows = cases.filter(
        (c) =>
          c.workspace_id === w.id ||
          (w.kind === "territory" &&
            workspaceById.get(c.workspace_id)?.parent_id === w.id),
      );
      return {
        id: w.id,
        clientId: w.client_id,
        parentId: w.parent_id || "",
        kind: w.kind,
        name: w.name,
        state: w.state,
        archived: w.archived,
        updatedAt: w.updated_at.toISOString(),
        memberIds:
          req.user.role === "owner"
            ? memberships
                .filter((m) => m.workspace_id === w.id)
                .map((m) => m.user_id)
            : [],
        caseIds: rows.map((c) => c.id),
        caseCount: rows.length,
        openCount: rows.filter(
          (c) => !["Completed", "Cancelled"].includes(c.data.status),
        ).length,
        balanceOwed: rows.reduce((n, c) => n + caseAmounts(c.data).due, 0),
      };
    }),
  });
}
const input = z.object({
  name: z.string().trim().min(1).max(150),
  clientId: z.string().max(100),
  kind: z.enum(["territory", "community"]),
  parentId: z.string().max(100).default(""),
  state: z.string().max(2).default(""),
  updatedAt: z.string().optional(),
});
export async function save(req, res) {
  owner(req.user);
  const v = input.parse(req.body);
  const id =
    req.params.id === "new"
      ? randomUUID()
      : z.string().uuid().parse(req.params.id);
  await transaction(async (db) => {
    await lockOwner(req, db);
    const old = (
      await db.query(
        "SELECT * FROM legalflow.workspaces WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    assert(
      (
        await db.query("SELECT 1 FROM legalflow.clients WHERE id=$1", [
          v.clientId,
        ])
      ).rowCount,
      422,
      "Select a customer company",
    );
    if (old) {
      assert(
        v.updatedAt &&
          new Date(v.updatedAt).getTime() === old.updated_at.getTime(),
        409,
        "Workspace changed. Reload and try again.",
      );
      assert(
        old.client_id === v.clientId &&
          old.kind === v.kind &&
          (old.parent_id || "") === v.parentId,
        422,
        "Company, type and parent cannot change. Move cases to a new workspace instead.",
      );
    }
    if (v.kind === "community") {
      const p = (
        await db.query(
          "SELECT * FROM legalflow.workspaces WHERE id=$1 AND kind='territory' AND NOT archived",
          [v.parentId],
        )
      ).rows[0];
      assert(
        p && p.client_id === v.clientId,
        422,
        "Choose a territory for this customer company",
      );
    } else assert(!v.parentId, 422, "Territories cannot have a parent");
    await db.query(
      "INSERT INTO legalflow.workspaces(id,client_id,parent_id,kind,name,state) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=$5,state=$6,updated_at=now()",
      [id, v.clientId, v.parentId || null, v.kind, v.name, v.state],
    );
    await audit(db, req.user, "workspace.saved", id);
  });
  res.json({ ok: true, id });
}
export async function archive(req, res) {
  owner(req.user);
  await transaction(async (db) => {
    await lockOwner(req, db);
    const w = (
      await db.query(
        "SELECT * FROM legalflow.workspaces WHERE id=$1 FOR UPDATE",
        [req.params.id],
      )
    ).rows[0];
    assert(w, 404, "Workspace not found");
    assert(
      req.body.updatedAt &&
        new Date(req.body.updatedAt).getTime() === w.updated_at.getTime(),
      409,
      "Workspace changed. Reload and try again.",
    );
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.cases WHERE workspace_id=$1 UNION ALL SELECT 1 FROM legalflow.workspaces WHERE parent_id=$1 AND NOT archived",
          [w.id],
        )
      ).rowCount,
      409,
      "Move all cases and archive child communities first",
    );
    await db.query(
      "UPDATE legalflow.workspaces SET archived=true,updated_at=now() WHERE id=$1",
      [w.id],
    );
    await db.query(
      "UPDATE legalflow.users SET updated_at=now() WHERE id IN(SELECT user_id FROM legalflow.workspace_members WHERE workspace_id=$1)",
      [w.id],
    );
    await db.query(
      "DELETE FROM legalflow.workspace_members WHERE workspace_id=$1",
      [w.id],
    );
    await audit(db, req.user, "workspace.archived", w.id);
  });
  res.json({ ok: true });
}
export async function access(req, res) {
  owner(req.user);
  const v = z
    .object({
      userId: z.string().max(100),
      workspaceIds: z.array(z.string().uuid()).max(500),
      customerAccess: z
        .enum(["all", "regional", "community"])
        .default("community"),
      updatedAt: z.string(),
    })
    .parse(req.body);
  await transaction(async (db) => {
    await lockOwner(req, db);
    const u = await findUser(v.userId, db);
    assert(u, 404, "User not found");
    assert(
      new Date(v.updatedAt).getTime() === u.updated_at.getTime(),
      409,
      "User access changed. Reload before saving.",
    );
    const ids = [...new Set(v.workspaceIds)];
    const rows = (
      await db.query(
        "SELECT * FROM legalflow.workspaces WHERE id=ANY($1::text[]) AND NOT archived",
        [ids],
      )
    ).rows;
    assert(rows.length === ids.length, 422, "Select active workspaces");
    if (u.role === "customer") {
      assert(
        rows.every((w) => w.client_id === u.client_id),
        422,
        "A customer can only access their own company workspaces",
      );
      if (v.customerAccess !== "all")
        assert(
          rows.every(
            (w) =>
              w.kind ===
              (v.customerAccess === "regional" ? "territory" : "community"),
          ),
          422,
          "Regional access uses territories; community access uses communities",
        );
      await db.query(
        "UPDATE legalflow.users SET customer_access=$2,updated_at=now() WHERE id=$1",
        [u.id, v.customerAccess],
      );
    } else
      await db.query(
        "UPDATE legalflow.users SET updated_at=now() WHERE id=$1",
        [u.id],
      );
    await db.query("DELETE FROM legalflow.workspace_members WHERE user_id=$1", [
      u.id,
    ]);
    for (const id of ids)
      await db.query(
        "INSERT INTO legalflow.workspace_members(workspace_id,user_id) VALUES($1,$2)",
        [id, u.id],
      );
    await audit(db, req.user, "workspace.access-updated", u.id);
  });
  res.json({
    ok: true,
    updatedAt: (await findUser(v.userId)).updated_at.toISOString(),
  });
}
export async function assign(req, res) {
  owner(req.user);
  const v = z
    .object({ workspaceId: z.string().max(100), updatedAt: z.string() })
    .parse(req.body);
  await transaction(async (db) => {
    await lockOwner(req, db);
    const c = await accessibleCase(req.user, req.params.id, db, {
      write: true,
      lock: true,
    });
    assert(
      new Date(v.updatedAt).getTime() === c.updated_at.getTime(),
      409,
      "Case changed. Reload before moving it.",
    );
    await validateWorkspace(db, v.workspaceId, c.client_id);
    await db.query(
      "UPDATE legalflow.cases SET workspace_id=$2,data=jsonb_set(data,'{workspaceId}',to_jsonb($3::text)),updated_at=now() WHERE id=$1",
      [c.id, v.workspaceId || null, v.workspaceId],
    );
    await activity(db, req.user, c.id, "Owner moved case workspace", "update");
    await audit(db, req.user, "case.workspace-moved", c.id);
  });
  res.json({ ok: true });
}
export async function validateWorkspace(db, id, clientId) {
  if (!id) return;
  const w = (
    await db.query(
      "SELECT w.* FROM legalflow.workspaces w JOIN legalflow.workspaces p ON p.id=w.parent_id WHERE w.id=$1 AND w.kind='community' AND NOT w.archived AND NOT p.archived",
      [id],
    )
  ).rows[0];
  assert(
    w && w.client_id === clientId,
    422,
    "Select a community workspace belonging to this case customer",
  );
}
export async function bulkAssign(req, res) {
  owner(req.user);
  const v = z
    .object({
      cases: z
        .array(z.object({ id: z.string().max(100), updatedAt: z.string() }))
        .min(1)
        .max(200),
      workspaceId: z.string().max(100),
    })
    .parse(req.body);
  await transaction(async (db) => {
    await lockOwner(req, db);
    assert(
      new Set(v.cases.map((c) => c.id)).size === v.cases.length,
      422,
      "Select each case once",
    );
    const rows = [];
    for (const item of [...v.cases].sort((a, b) => a.id.localeCompare(b.id))) {
      const c = await accessibleCase(req.user, item.id, db, {
        write: true,
        lock: true,
      });
      assert(
        new Date(item.updatedAt).getTime() === c.updated_at.getTime(),
        409,
        "A selected case changed. Reload before moving cases.",
      );
      await validateWorkspace(db, v.workspaceId, c.client_id);
      rows.push(c);
    }
    for (const c of rows) {
      await db.query(
        "UPDATE legalflow.cases SET workspace_id=$2,data=jsonb_set(data,'{workspaceId}',to_jsonb($3::text)),updated_at=now() WHERE id=$1",
        [c.id, v.workspaceId || null, v.workspaceId],
      );
      await activity(
        db,
        req.user,
        c.id,
        "Owner moved case workspace",
        "update",
      );
      await audit(db, req.user, "case.workspace-moved", c.id);
    }
  });
  res.json({ ok: true, count: v.cases.length });
}
