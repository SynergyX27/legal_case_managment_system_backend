import { visible } from "../services/access.service.js";
import { validateWorkspace } from "./workspaces.controller.js";
import { territoryCode } from "../services/territories.js";
import { queueCaseOpened } from "../services/email-events.service.js";
import { permit } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { randomUUID } from "node:crypto";
import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { accessibleCase, validateAssignments } from "../models/case.model.js";
import { audit, activity, notify } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function saveCase(db, user, input, metadata = {}) {
  const req = { user, body: input };
  const v = schema.caseInput.parse(input);
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
  );
  req.user = await findUser(req.user.id, db);
  const old = (
    await db.query("SELECT * FROM legalflow.cases WHERE id=$1 FOR UPDATE", [
      v.id,
    ])
  ).rows[0];
  permit(req.user, old ? "cases.edit" : "cases.create");
  if (old) await accessibleCase(req.user, v.id, db, { write: true });
  if (!old && req.user.role === "staff") {
    v.staffId = req.user.id;
    v.managerId = req.user.manager_id || "";
  }
  if (old) {
    assert(
      typeof req.body.updatedAt === "string" &&
        new Date(req.body.updatedAt).getTime() === old.updated_at.getTime(),
      409,
      "This case changed on another device. Reopen the case and apply your changes again",
    );
    if (old.client_id !== v.clientId)
      assert(
        !(
          await db.query("SELECT 1 FROM legalflow.invoices WHERE case_id=$1", [
            v.id,
          ])
        ).rowCount,
        409,
        "The customer cannot change after invoices have been created",
      );
  }
  const workspaceId = v.workspaceId ?? old?.workspace_id ?? "";
  if (workspaceId !== (old?.workspace_id || ""))
    assert(
      req.user.role === "owner",
      403,
      "Only the owner can assign or move case workspaces",
    );
  await validateWorkspace(db, workspaceId, v.clientId);
  await validateAssignments(v, req.user, db);
  if (old && req.user.role === "staff")
    assert(
      old.client_id === v.clientId &&
        old.manager_id === (v.managerId || null) &&
        old.staff_id === v.staffId,
      403,
      "Staff cannot change case customer or manager",
    );
  const fields = (
    await db.query("SELECT data FROM legalflow.custom_fields")
  ).rows.map((r) => r.data);
  for (const f of fields)
    assert(
      !f.required || (v.custom[f.id] !== undefined && v.custom[f.id] !== ""),
      422,
      `${f.label} is required`,
    );
  const territory = territoryCode(v.state || old?.data.state);
  let refId = old?.data.refId || "";
  if (!refId && territory) {
    const next = (
      await db.query("SELECT nextval('legalflow.case_ref_numbers') AS n")
    ).rows[0].n;
    refId =
      territory +
      String(new Date().getUTCFullYear()).slice(-2) +
      "-" +
      String(next).padStart(5, "0");
  }
  await db.query(
    "INSERT INTO legalflow.cases(id,number,client_id,staff_id,manager_id,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET number=$2,client_id=$3,staff_id=$4,manager_id=$5,data=$6,updated_at=now()",
    [
      v.id,
      v.number,
      v.clientId,
      v.staffId || null,
      v.managerId || null,
      {
        moneyOwed: 0,
        ...old?.data,
        ...v,
        ...(territory ? { state: territory } : {}),
        refId,
        ...metadata,
      },
    ],
  );
  await db.query("UPDATE legalflow.cases SET workspace_id=$2 WHERE id=$1", [
    v.id,
    workspaceId || null,
  ]);
  if (!old) await queueCaseOpened(db, v);
  await activity(
    db,
    req.user,
    v.id,
    old ? "Case updated" : "Case created",
    old ? "update" : "create",
  );
  await audit(db, req.user, old ? "case.updated" : "case.created", v.id);
  const customer = await db.query(
    "SELECT id FROM legalflow.users WHERE client_id=$1",
    [v.clientId],
  );
  const customerUsers = [];
  for (const row of customer.rows)
    customerUsers.push(await findUser(row.id, db));
  await notify(
    db,
    [
      v.staffId,
      v.managerId,
      ...customerUsers
        .filter((u) =>
          visible(u, {
            client_id: v.clientId,
            staff_id: v.staffId,
            manager_id: v.managerId,
            workspace_id: workspaceId || null,
          }),
        )
        .map((u) => u.id),
    ].filter((id) => id !== req.user.id),
    "case",
    `Case ${v.number} ${old ? "updated" : "created"}`,
    `/cases/${v.id}`,
  );
  return v.id;
}
export async function putCase(req, res) {
  const id = await transaction((db) =>
    saveCase(db, req.user, { ...req.body, id: req.params.id }),
  );
  res.json({ ok: true, id });
}
export async function deleteCase(req, res) {
  permit(req.user, "cases.delete");
  await transaction(async (db) => {
    await accessibleCase(req.user, req.params.id, db, {
      write: true,
      lock: true,
    });
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.documents WHERE case_id=$1 UNION ALL SELECT 1 FROM legalflow.invoices WHERE case_id=$1",
          [req.params.id],
        )
      ).rowCount,
      409,
      "Cases with documents or invoices must be retained. Delete their documents or cancel the case",
    );
    await db.query("DELETE FROM legalflow.cases WHERE id=$1", [req.params.id]);
    await audit(db, req.user, "case.deleted", req.params.id);
  });
  res.json({ ok: true });
}
export async function comment(req, res) {
  const { text } = schema.messageInput.parse(req.body);
  await transaction(async (db) => {
    await accessibleCase(req.user, req.params.id, db, { write: true });
    await db.query(
      "INSERT INTO legalflow.comments(id,case_id,user_id,text) VALUES($1,$2,$3,$4)",
      [randomUUID(), req.params.id, req.user.id, text],
    );
    await activity(
      db,
      req.user,
      req.params.id,
      "Internal comment added",
      "comment",
    );
  });
  res.json({ ok: true });
}
