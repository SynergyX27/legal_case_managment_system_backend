import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { permit } from "../services/access.service.js";
import { accessibleCase } from "../models/case.model.js";
import { audit, activity, notify } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function putInvoice(req, res) {
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
    permit(req.user, old ? "invoices.edit" : "invoices.create");
    assert(!old?.deleted_at, 409, "This invoice has been deleted");
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
    if (old) {
      assert(
        old.data.paymentMethod !== "stripe" &&
          old.data.status !== "Paid" &&
          !old.data.paidAt,
        409,
        "Paid invoices cannot be edited",
      );
      const active = await db.query(
        "SELECT 1 FROM legalflow.invoice_payments WHERE invoice_id=$1 AND status IN ('creating','open','processing')",
        [v.id],
      );
      assert(
        !active.rowCount,
        409,
        "This invoice has an active online checkout. Wait for payment confirmation or checkout expiry before editing or recording a manual payment",
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
    if (old)
      await db.query(
        "UPDATE legalflow.invoices SET data=$2,updated_at=now() WHERE id=$1",
        [v.id, data],
      );
    else
      await db.query(
        "INSERT INTO legalflow.invoices(id,number,case_id,client_id,data) VALUES($1,$2,$3,$4,$5)",
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

export async function deleteInvoice(req, res) {
  permit(req.user, "invoices.delete");
  const id = schema.id.parse(req.params.id);
  await transaction(async (db) => {
    const initial = (
      await db.query(
        "SELECT case_id FROM legalflow.invoices WHERE id=$1 AND deleted_at IS NULL",
        [id],
      )
    ).rows[0];
    assert(initial, 404, "Invoice not found");
    await accessibleCase(req.user, initial.case_id, db, { lock: true });
    const invoice = (
      await db.query(
        "SELECT * FROM legalflow.invoices WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    assert(!invoice.deleted_at, 404, "Invoice not found");
    assert(
      typeof req.body?.updatedAt === "string" &&
        new Date(req.body.updatedAt).getTime() === invoice.updated_at.getTime(),
      409,
      "Invoice changed on another device. Reload before deleting",
    );
    assert(
      invoice.data.status !== "Paid" &&
        !invoice.data.paidAt &&
        invoice.data.paymentMethod !== "stripe",
      409,
      "Paid invoices cannot be deleted",
    );
    const payments = await db.query(
      "SELECT 1 FROM legalflow.invoice_payments WHERE invoice_id=$1 AND status IN ('creating','open','processing','paid')",
      [id],
    );
    assert(
      !payments.rowCount,
      409,
      "This invoice has a payment or active checkout. Wait for confirmation or checkout expiry before deleting",
    );
    await db.query(
      "UPDATE legalflow.invoices SET deleted_at=now(),updated_at=now() WHERE id=$1",
      [id],
    );
    await activity(
      db,
      req.user,
      invoice.case_id,
      invoice.number + " deleted",
      "invoice",
    );
    await audit(db, req.user, "invoice.deleted", id);
  });
  res.json({ ok: true });
}
