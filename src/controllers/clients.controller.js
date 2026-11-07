import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { owner } from "../services/access.service.js";
import { audit } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function putClient(req, res) {
  owner(req.user);
  const v = schema.clientInput.parse({ ...req.body, id: req.params.id });
  await transaction(async (db) => {
    assert(
      (
        await db.query(
          "SELECT 1 FROM legalflow.clients WHERE id=$1 FOR UPDATE",
          [v.id],
        )
      ).rowCount,
      404,
      "Customer not found. Create customers through People & access",
    );
    await db.query("UPDATE legalflow.clients SET data=$2 WHERE id=$1", [
      v.id,
      { ...v, accountId: "company", company: v.name },
    ]);
    await db.query(
      "UPDATE legalflow.users SET name=$2,email=$3,phone=$4,updated_at=now() WHERE client_id=$1",
      [v.id, v.name, v.email.toLowerCase(), v.phone],
    );
    await audit(db, req.user, "customer.updated", v.id);
  });
  res.json({ ok: true });
}
export async function deleteClient(req, res) {
  owner(req.user);
  await transaction(async (db) => {
    const linked = (
      await db.query("SELECT id FROM legalflow.users WHERE client_id=$1", [
        req.params.id,
      ])
    ).rows[0];
    assert(
      !linked,
      409,
      "This customer has a login. Deactivate the account in People & access to preserve their history",
    );
    await db.query("DELETE FROM legalflow.clients WHERE id=$1", [
      req.params.id,
    ]);
    await audit(db, req.user, "customer.deleted", req.params.id);
  });
  res.json({ ok: true });
}
