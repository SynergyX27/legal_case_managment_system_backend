import {
  invoiceCaseIds,
  invoiceTotals,
} from "../services/invoice-math.service.js";
import { visible } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import {
  queueInvoiceIssued,
  queuePaymentCompleted,
} from "../services/email-events.service.js";
import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { permit } from "../services/access.service.js";
import { accessibleCase } from "../models/case.model.js";
import { audit, activity, notify } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function putInvoice(req, res) {
  const v = schema.invoiceInput.parse({ ...req.body, id: req.params.id });
  await transaction(async (db) => {
    const ids = invoiceCaseIds(v);
    const cases = [];
    for (const id of ids)
      cases.push(await accessibleCase(req.user, id, db, { lock: true }));
    const c = cases.find((x) => x.id === v.caseId);
    assert(
      cases.every((x) => x.client_id === v.clientId),
      422,
      "All invoice cases must belong to the same customer",
    );
    const existing = (
      await db.query("SELECT data FROM legalflow.invoices WHERE id=$1", [v.id])
    ).rows[0];
    if (!existing && ids.length > 1) {
      assert(
        c.workspace_id &&
          c.data.serviceDate &&
          cases.every(
            (x) =>
              x.workspace_id === c.workspace_id &&
              x.data.serviceDate === c.data.serviceDate &&
              x.data.propertyType === "APT",
          ),
        422,
        "Grouped invoices require apartment cases in the same assigned community and service date",
      );
    }
    assert(
      v.lines.every((l) => ids.includes(l.caseId || v.caseId)),
      422,
      "Every line must belong to an included case",
    );
    assert(
      ids.every((id) => v.lines.some((l) => (l.caseId || v.caseId) === id)),
      422,
      "Every included case needs a line item",
    );
    assert(
      invoiceTotals({ ...v, pricingVersion: 2 }).net >= 0,
      422,
      "Discount cannot exceed the base price",
    );
    let template =
      ids.length > 1 ? "T2B" : c.data.propertyType === "APT" ? "T2A" : "T1";
    if (existing?.data.template) template = existing.data.template;
    assert(
      !v.template || v.template === template,
      422,
      "Invoice template must match its property type and included cases",
    );
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
        old.case_id === v.caseId &&
          JSON.stringify(invoiceCaseIds(old.data)) === JSON.stringify(ids),
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
    assert(
      Number.isSafeInteger(invoiceTotals({ ...v, pricingVersion: 2 }).total) &&
        invoiceTotals({ ...v, pricingVersion: 2 }).total <= 99999999,
      422,
      "Invoice total must not exceed $999,999.99",
    );
    const seq = old
      ? ""
      : String(
          (await db.query("SELECT nextval('legalflow.invoice_numbers') AS n"))
            .rows[0].n,
        ).padStart(6, "0");
    const serviceDate = c.data.serviceDate || v.date;
    const address =
      (c.data.residentAddress || "SERVICE")
        .split(/\s+/)[0]
        .replace(/[^a-zA-Z0-9-]/g, "")
        .slice(0, 30) || "SERVICE";
    const number =
      old?.number ||
      `${address}-X${serviceDate.slice(2, 4)}-${serviceDate.slice(5)}-${seq}`;
    const paidAt =
      v.status === "Paid"
        ? old?.data.paidAt || new Date().toISOString()
        : undefined;
    const data = {
      ...v,
      number,
      caseIds: ids,
      pricingVersion:
        old?.data.pricingVersion || (old && !old.data.caseIds ? 1 : 2),
      template,
      discount: v.discount || 0,
      caseSnapshots:
        old?.data.status !== "Draft" && old?.data.caseSnapshots
          ? old.data.caseSnapshots
          : cases.map((x) => ({
              id: x.id,
              number: x.number,
              refId: x.data.refId,
              tenant: x.data.residentName,
              address: x.data.residentAddress,
              unit: x.data.unit,
              community: x.data.community,
              serviceDate: x.data.serviceDate,
            })),
      ...(paidAt ? { paidAt } : {}),
    };
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
    if (v.status === "Paid" && old?.data.status !== "Paid")
      await queuePaymentCompleted(db, data, "manual");
    else if (
      ["Sent", "Overdue"].includes(v.status) &&
      (!old || old.data.status === "Draft")
    )
      await queueInvoiceIssued(db, data);
    for (const caseId of ids)
      await activity(db, req.user, caseId, `${number}: ${v.status}`, "invoice");
    await audit(db, req.user, "invoice.saved", v.id);
    if (v.status !== "Draft") {
      const recipients = (
        await db.query(
          "SELECT id FROM legalflow.users WHERE client_id=$1 AND deleted_at IS NULL",
          [v.clientId],
        )
      ).rows;
      const customerUsers = [];
      for (const row of recipients)
        customerUsers.push(await findUser(row.id, db));
      await notify(
        db,
        customerUsers
          .filter((u) => cases.every((c) => visible(u, c)))
          .map((u) => u.id),
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
        "SELECT case_id,data FROM legalflow.invoices WHERE id=$1 AND deleted_at IS NULL",
        [id],
      )
    ).rows[0];
    assert(initial, 404, "Invoice not found");
    for (const caseId of invoiceCaseIds(initial.data))
      await accessibleCase(req.user, caseId, db, { lock: true });
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
