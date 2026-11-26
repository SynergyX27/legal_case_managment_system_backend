import { visible } from "../services/access.service.js";
import { validateWorkspace } from "./workspaces.controller.js";
import { territoryCode } from "../services/territories.js";
import { queueCaseOpened } from "../services/email-events.service.js";
import { permit } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "../config/database.js";
import { removeFile } from "../services/dropbox.service.js";
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
          await db.query(
            "SELECT 1 FROM legalflow.invoices WHERE (case_id=$1 OR (data->'caseIds') ? $1)",
            [v.id],
          )
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
    "SELECT id FROM legalflow.users WHERE client_id=$1 AND deleted_at IS NULL",
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
  let step = "permission";
  const cleanup = [];
  try {
    permit(req.user, "cases.delete");
    await transaction(async (db) => {
      // Coordinate with inbox attachment uploads without waiting on a long IMAP poll.
      step = "email-sync";
      const sync = await db.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('legalflow-email-incoming')) AS acquired",
      );
      assert(
        sync.rows[0].acquired,
        409,
        "Email synchronization is running. Try deleting the case again shortly",
      );
      step = "case-access";
      await accessibleCase(req.user, req.params.id, db, {
        write: true,
        lock: true,
      });
      step = "linked-records";
      assert(
        !(
          await db.query(
            "SELECT 1 FROM legalflow.documents WHERE case_id=$1 UNION ALL SELECT 1 FROM legalflow.invoices WHERE (case_id=$1 OR (data->'caseIds') ? $1)",
            [req.params.id],
          )
        ).rowCount,
        409,
        "Cases with documents or invoices must be retained. Delete their documents or cancel the case",
      );
      const threads = await db.query(
        "SELECT id FROM legalflow.email_threads WHERE case_id=$1 FOR UPDATE",
        [req.params.id],
      );
      assert(
        !threads.rowCount || req.body?.deleteEmailConversations === true,
        409,
        "This case has email conversations. Confirm deletion of the case and its linked email conversations",
      );
      step = "email-outbox";
      const mail = await db.query(
        "SELECT o.id,o.state FROM legalflow.email_outbox o WHERE o.id IN (SELECT m.outbox_id FROM legalflow.email_messages m JOIN legalflow.email_threads t ON t.id=m.thread_id WHERE t.case_id=$1) OR o.event_key=$2 FOR UPDATE",
        [req.params.id, `case.created:${req.params.id}`],
      );
      assert(
        !mail.rows.some((m) => m.state === "sending"),
        409,
        "An email for this case is currently being sent. Try deleting the case again shortly",
      );
      step = "email-attachments";
      const attachments = await db.query(
        "SELECT a.* FROM legalflow.email_attachments a JOIN legalflow.email_messages m ON m.id=a.message_id JOIN legalflow.email_threads t ON t.id=m.thread_id WHERE t.case_id=$1 FOR UPDATE OF a",
        [req.params.id],
      );
      // Durable retries use the existing document reconciliation queue.
      for (const file of attachments.rows) {
        if (!file.dropbox_path) continue;
        const id = randomUUID();
        const queued = await db.query(
          "INSERT INTO legalflow.documents(id,case_id,name,mime,bytes,kind,dropbox_path,uploaded_by,state) VALUES($1,NULL,$2,$3,$4,'other',$5,$6,'deleting') ON CONFLICT(dropbox_path) DO NOTHING RETURNING id",
          [
            id,
            file.name,
            file.mime,
            file.bytes,
            file.dropbox_path,
            req.user.id,
          ],
        );
        if (queued.rowCount) cleanup.push({ id, path: file.dropbox_path });
      }
      step = "email-conversations";
      // Messages, attachment rows and read markers cascade with the thread.
      await db.query("DELETE FROM legalflow.email_threads WHERE case_id=$1", [
        req.params.id,
      ]);
      if (mail.rowCount)
        await db.query(
          "DELETE FROM legalflow.email_outbox WHERE id=ANY($1::text[])",
          [mail.rows.map((m) => m.id)],
        );
      step = "delete-case";
      await db.query("DELETE FROM legalflow.cases WHERE id=$1", [
        req.params.id,
      ]);
      step = "audit";
      await audit(db, req.user, "case.deleted-with-email", req.params.id);
      step = "commit";
    });
    // External file removal follows commit; failed removals remain retryable.
    let cleanupPending = false;
    for (const file of cleanup) {
      try {
        await removeFile(file.path);
        await pool.query(
          "DELETE FROM legalflow.documents WHERE id=$1 AND state='deleting'",
          [file.id],
        );
      } catch {
        cleanupPending = true;
      }
    }
    res.json({ ok: true, cleanupPending });
  } catch (error) {
    error.operation = "case.delete";
    error.failureStep = step;
    throw error;
  }
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
