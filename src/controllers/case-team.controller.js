import { z } from "zod";
import { transaction } from "../config/database.js";
import { accessibleCase } from "../models/case.model.js";
import { findUser } from "../models/user.model.js";
import { assert } from "../utils/errors.js";
import { activity, audit, notify } from "../models/audit.model.js";
const input = z
  .object({
    cases: z
      .array(
        z.object({
          id: z.string().min(1).max(150),
          updatedAt: z.string().datetime(),
        }),
      )
      .min(1)
      .max(200),
    memberIds: z.array(z.string().min(1).max(150)).max(100),
    mode: z.enum(["replace", "add"]).default("replace"),
  })
  .strict();
export async function assign(req, res) {
  const v = input.parse(req.body);
  assert(
    new Set(v.cases.map((c) => c.id)).size === v.cases.length,
    422,
    "Select each case only once",
  );
  await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    const user = await findUser(req.user.id, db);
    assert(
      user?.status === "Active" && ["owner", "manager"].includes(user.role),
      403,
      "Only owners and managers can assign case teams",
    );
    const ids = [...new Set(v.memberIds)];
    const members = await db.query(
      "SELECT id FROM legalflow.users WHERE id=ANY($1::text[]) AND role IN ('staff','manager') AND status='Active' AND deleted_at IS NULL",
      [ids],
    );
    assert(
      members.rowCount === ids.length,
      422,
      "Select active staff and managers",
    );
    for (const record of [...v.cases].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const c = await accessibleCase(user, record.id, db, {
        write: true,
        lock: true,
      });
      assert(
        new Date(record.updatedAt).getTime() === c.updated_at.getTime(),
        409,
        "A case changed. Refresh and assign the team again",
      );
      const next = [
        ...new Set([
          ...(v.mode === "add" ? c.data.teamMemberIds || [] : []),
          ...ids,
        ]),
      ];
      assert(
        next.length <= 100,
        422,
        "A case can have at most 100 additional team members",
      );
      await db.query(
        "UPDATE legalflow.cases SET data=jsonb_set(data,'{teamMemberIds}',$2::jsonb),updated_at=now() WHERE id=$1",
        [c.id, JSON.stringify(next)],
      );
      await activity(db, user, c.id, "Case team updated", "update");
      await audit(db, user, "case.team.updated", c.id);
      await notify(
        db,
        next.filter(
          (id) => id !== user.id && !(c.data.teamMemberIds || []).includes(id),
        ),
        "case",
        `Assigned to case ${c.number}`,
        `/cases/${c.id}`,
      );
    }
  });
  res.json({ ok: true, count: v.cases.length });
}
