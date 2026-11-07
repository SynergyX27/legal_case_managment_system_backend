import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { internal } from "../services/access.service.js";
import { audit, notify } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function putEvent(req, res) {
  assert(internal(req.user), 403, "Team access required");
  const v = schema.eventInput.parse({ ...req.body, id: req.params.id });
  await transaction(async (db) => {
    const old = (
      await db.query("SELECT * FROM legalflow.events WHERE id=$1 FOR UPDATE", [
        v.id,
      ])
    ).rows[0];
    assert(
      req.user.role !== "staff" ||
        ((!old || old.staff_id === req.user.id) && v.staffId === req.user.id),
      403,
      "Staff can only manage their own appointments",
    );
    if (v.staffId)
      assert(
        (
          await db.query(
            "SELECT 1 FROM legalflow.users WHERE id=$1 AND role<>'customer' AND status='Active'",
            [v.staffId],
          )
        ).rowCount,
        422,
        "Select an active team member",
      );
    await db.query(
      "INSERT INTO legalflow.events(id,staff_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET staff_id=$2,data=$3",
      [v.id, v.staffId || null, v],
    );
    await audit(db, req.user, "appointment.saved", v.id);
    if (v.staffId !== req.user.id)
      await notify(
        db,
        [v.staffId],
        "calendar",
        `Appointment: ${v.title}`,
        "/calendar",
      );
  });
  res.json({ ok: true });
}
export async function deleteEvent(req, res) {
  assert(internal(req.user), 403, "Team access required");
  await transaction(async (db) => {
    const old = (
      await db.query("SELECT * FROM legalflow.events WHERE id=$1 FOR UPDATE", [
        req.params.id,
      ])
    ).rows[0];
    assert(old, 404, "Appointment not found");
    assert(
      req.user.role !== "staff" || old.staff_id === req.user.id,
      403,
      "Staff can only manage their own appointments",
    );
    await db.query("DELETE FROM legalflow.events WHERE id=$1", [req.params.id]);
    await audit(db, req.user, "appointment.deleted", req.params.id);
  });
  res.json({ ok: true });
}
