import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { biller } from "../services/access.service.js";
import { accessibleCase } from "../models/case.model.js";
import { audit, activity, notify } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function putInvoice(req, res) {
  biller(req.user);
  const v = schema.invoiceInput.parse({ ...req.body, id: req.params.id });
  await transaction(async (db) => {
    const c = await accessibleCase(req.user, v.caseId, db, { lock: true });
    assert(
      c.client_id === v.clientId,
      422,
      "Invoice customer must match the case",
    );
    const old = (
      await db.query(
        "SELECT * FROM legalflow.invoices WHERE id=$1 FOR UPDATE",
        [v.id],
      )
    ).rows[0];
    if (old) {
      assert(
        typeof req.body.updatedAt === "string" &&
          new Date(req.body.updatedAt).getTime() === old.updated_at.getTime(),
        409,
        "This invoice changed on another device. Reopen it before saving",
      );
      await accessibleCase(req.user, old.case_id, db);
      assert(
        old.case_id === v.caseId,
        422,
        "An invoice cannot be moved to another case",
      );
    }
    const number =
      old?.number ||
      `INV-${String((await db.query("SELECT nextval('legalflow.invoice_numbers') AS n")).rows[0].n).padStart(6, "0")}`;
    const paidAt =
      v.status === "Paid"
        ? old?.data.paidAt || new Date().toISOString()
        : undefined;
    const data = { ...v, number, ...(paidAt ? { paidAt } : {}) };
    await db.query(
      "INSERT INTO legalflow.invoices(id,number,case_id,client_id,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=$5,updated_at=now()",
      [v.id, number, v.caseId, v.clientId, data],
    );
    await activity(db, req.user, v.caseId, `${number}: ${v.status}`, "invoice");
    await audit(db, req.user, "invoice.saved", v.id);
    if (v.status !== "Draft") {
      const recipients = (
        await db.query("SELECT id FROM legalflow.users WHERE client_id=$1", [
          v.clientId,
        ])
      ).rows;
      await notify(
        db,
        recipients.map((u) => u.id),
        "invoice",
        `${number} is ${v.status.toLowerCase()}`,
        "/invoices",
      );
    }
  });
  res.json({ ok: true });
}
