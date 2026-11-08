import { queueCaseOpened } from "../services/email-events.service.js";
import { permit } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { randomUUID } from "node:crypto";
import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { accessibleCase, validateAssignments } from "../models/case.model.js";
import { audit, activity, notify } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function putCase(req, res) {
  const v = schema.caseInput.parse({ ...req.body, id: req.params.id });
  await transaction(async (db) => {
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
            await db.query(
              "SELECT 1 FROM legalflow.invoices WHERE case_id=$1",
              [v.id],
            )
          ).rowCount,
          409,
          "The customer cannot change after invoices have been created",
        );
    }
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
    await db.query(
      "INSERT INTO legalflow.cases(id,number,client_id,staff_id,manager_id,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET number=$2,client_id=$3,staff_id=$4,manager_id=$5,data=$6,updated_at=now()",
      [v.id, v.number, v.clientId, v.staffId || null, v.managerId || null, v],
    );
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
    await notify(
      db,
      [v.staffId, v.managerId, ...customer.rows.map((u) => u.id)].filter(
        (id) => id !== req.user.id,
      ),
      "case",
      `Case ${v.number} ${old ? "updated" : "created"}`,
      `/cases/${v.id}`,
    );
  });
  res.json({ ok: true, id: v.id });
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
