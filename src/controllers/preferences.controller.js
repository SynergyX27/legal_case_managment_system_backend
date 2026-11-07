import { z } from "zod";
import { pool } from "../config/database.js";
import { owner } from "../services/access.service.js";
import * as schema from "../validators/schemas.js";
export async function preferences(req, res) {
  const data = schema.preferenceInput.parse(req.body);
  await pool.query(
    "INSERT INTO legalflow.preferences(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=legalflow.preferences.data||$2::jsonb",
    [req.user.id, data],
  );
  res.json({ ok: true });
}
export async function readNotifications(req, res) {
  const v = z.object({ id: schema.id.optional() }).parse(req.body);
  await pool.query(
    "UPDATE legalflow.notifications SET read=true WHERE user_id=$1 AND ($2::text IS NULL OR id=$2)",
    [req.user.id, v.id || null],
  );
  res.json({ ok: true });
}
export async function putField(req, res) {
  owner(req.user);
  const v = schema.customFieldInput.parse({ ...req.body, id: req.params.id });
  await pool.query(
    "INSERT INTO legalflow.custom_fields(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=$2",
    [v.id, v],
  );
  res.json({ ok: true });
}
export async function deleteField(req, res) {
  owner(req.user);
  await pool.query("DELETE FROM legalflow.custom_fields WHERE id=$1", [
    req.params.id,
  ]);
  res.json({ ok: true });
}
