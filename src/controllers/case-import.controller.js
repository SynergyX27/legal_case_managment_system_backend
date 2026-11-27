import { can } from "../services/access.service.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "../config/database.js";
import { permit } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { id, caseInput } from "../validators/schemas.js";
import {
  parseCaseFile,
  prepareImport,
} from "../services/case-import.service.js";
import { saveCase } from "./cases.controller.js";
import { assert } from "../utils/errors.js";

export async function preview(req, res) {
  permit(req.user, "cases.create");
  let defaults;
  try {
    defaults = JSON.parse(req.body.defaults || "{}");
  } catch {
    assert(false, 422, "Invalid import defaults");
  }
  defaults = z
    .object({
      clientId: z.string().optional(),
      staffId: z.string().optional(),
      status: z.string().optional(),
      custom: z.record(z.any()).optional(),
    })
    .parse(defaults);
  let rawRows;
  try {
    rawRows = await parseCaseFile(req.file);
  } catch (error) {
    if (error.status) throw error;
    assert(
      false,
      422,
      "Could not read the spreadsheet. Save it as CSV or XLSX and try again.",
    );
  }
  const [clients, users, numbers, fields] = await Promise.all([
    pool.query(
      "SELECT id,data FROM legalflow.clients WHERE data->>'deleted' IS DISTINCT FROM 'true'",
    ),
    pool.query(
      "SELECT id,name,email,username,role,status,manager_id,client_id FROM legalflow.users WHERE deleted_at IS NULL",
    ),
    pool.query("SELECT number FROM legalflow.cases"),
    pool.query("SELECT data FROM legalflow.custom_fields"),
  ]);
  const results = prepareImport(
    rawRows,
    defaults,
    req.user,
    clients.rows.map((x) => ({
      ...x.data,
      id: x.id,
      username: users.rows.find((u) => u.client_id === x.id)?.username,
    })),
    users.rows,
    numbers.rows.map((x) => x.number),
    fields.rows.map((x) => x.data),
  );
  res.json({ results, valid: results.filter((x) => x.case).length });
}
export async function commit(req, res) {
  const v = z
    .object({ batchId: id, cases: z.array(caseInput).min(1).max(1000) })
    .parse(req.body);
  const digest = createHash("sha256")
    .update(JSON.stringify(v.cases))
    .digest("hex");
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "case-import:" + v.batchId,
    ]);
    const user = await findUser(req.user.id, db);
    permit(user, "cases.create");
    const ids = v.cases.map((c) => c.id);
    assert(new Set(ids).size === ids.length, 422, "Duplicate case IDs");
    const previous = (
      await db.query(
        "SELECT data FROM legalflow.cases WHERE id=ANY($1::text[])",
        [ids],
      )
    ).rows;
    if (previous.length) {
      assert(
        previous.length === ids.length &&
          previous.every(
            (x) =>
              x.data.importBatchId === v.batchId &&
              x.data.importHash === digest &&
              x.data.importedBy === user.id,
          ),
        409,
        "The import conflicts with an existing case. Preview the file again.",
      );
      return;
    }
    for (const record of v.cases)
      await saveCase(db, user, record, {
        importBatchId: v.batchId,
        importHash: digest,
        importedBy: user.id,
      });
  });
  res.json({ ok: true, count: v.cases.length });
}
export async function bulkUpdate(req, res) {
  const v = z
    .object({
      cases: z
        .array(z.object({ id, updatedAt: z.string().datetime() }))
        .min(1)
        .max(1000),
      patch: z.object({
        status: caseInput.shape.status.optional(),
        staffId: id.optional(),
      }),
    })
    .parse(req.body);
  assert(
    v.patch.status || v.patch.staffId,
    422,
    "Choose a status or staff member",
  );
  await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    const user = await findUser(req.user.id, db);
    if (!v.patch.status || v.patch.staffId) permit(user, "cases.edit");
    else
      assert(
        can(user, "cases.edit") ||
          can(user, "cases.edit_operations") ||
          can(user, "cases.update_progress"),
        403,
        "Case progress permission required",
      );
    for (const record of [...v.cases].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const old = (
        await db.query("SELECT * FROM legalflow.cases WHERE id=$1", [record.id])
      ).rows[0];
      assert(old, 404, "Case not found");
      let team = {};
      if (v.patch.staffId) {
        assert(
          user.role === "owner",
          403,
          "Only the owner can change primary staff and manager assignments",
        );
        const staff = (
          await db.query("SELECT manager_id FROM legalflow.users WHERE id=$1", [
            v.patch.staffId,
          ])
        ).rows[0];
        team = { staffId: v.patch.staffId, managerId: staff?.manager_id || "" };
      }
      await saveCase(db, user, {
        ...old.data,
        ...record,
        number: old.number,
        clientId: old.client_id,
        staffId: old.staff_id,
        managerId: old.manager_id,
        ...(v.patch.status ? { status: v.patch.status } : {}),
        ...team,
      });
    }
  });
  res.json({ ok: true, count: v.cases.length });
}
