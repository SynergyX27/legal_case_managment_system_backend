import { z } from "zod";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { randomUUID } from "node:crypto";
import { pool } from "../config/database.js";
import { accessibleCase } from "../models/case.model.js";
import {
  withCaseBalances,
  caseAmounts,
} from "../services/case-balance.service.js";
import { singleCasePdf } from "../services/single-case-report.service.js";
import { assert } from "../utils/errors.js";
import { env } from "../config/env.js";
const input = z
  .object({
    caseIds: z.array(z.string().min(1).max(150)).min(1).max(200),
    format: z.enum(["pdf", "xlsx"]).default("pdf"),
    to: z.string().email().max(254).optional(),
    photoId: z.string().max(150).optional(),
  })
  .strict();
export async function exportCases(req, res) {
  const v = input.parse(req.body),
    ids = [...new Set(v.caseIds)];
  assert(
    v.format === "xlsx" || ids.length <= 25,
    422,
    "Select at most 25 cases per combined PDF",
  );
  assert(
    !v.photoId || ids.length === 1,
    422,
    "Choose a cover photo for a single case only",
  );
  if (v.to) assert(env.SMTP_ENABLED, 503, "Email delivery is disabled");
  // Authorize the complete selection before rendering anything.
  const raw = [];
  for (const id of ids) raw.push(await accessibleCase(req.user, id));
  const rows = await withCaseBalances(pool, raw);
  let buffer;
  if (v.format === "pdf") {
    const combined = await PDFDocument.create();
    for (const id of ids) {
      const r = await singleCasePdf(req.user, id, v.photoId);
      const source = await PDFDocument.load(r.buffer);
      for (const page of await combined.copyPages(
        source,
        source.getPageIndices(),
      ))
        combined.addPage(page);
    }
    buffer = Buffer.from(await combined.save());
  } else {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Case reports");
    const clients = (
      await pool.query(
        "SELECT id,data FROM legalflow.clients WHERE id=ANY($1::text[])",
        [rows.map((c) => c.client_id)],
      )
    ).rows;
    const users = (
      await pool.query(
        "SELECT id,name FROM legalflow.users WHERE deleted_at IS NULL",
      )
    ).rows;
    const customFields = (
      await pool.query(
        "SELECT id,data FROM legalflow.custom_fields ORDER BY id",
      )
    ).rows;
    const names = (ids) =>
      ids
        .map((id) => users.find((u) => u.id === id)?.name || "")
        .filter(Boolean)
        .join(", ");
    sheet.addRow([
      "Case number",
      "REF CL#",
      "REF ID#",
      "Customer",
      "Community",
      "Tenant",
      "Address",
      "Unit",
      "County",
      "City",
      "State",
      "Zip",
      "Property type",
      "Attorney",
      "Status",
      "Priority",
      "Service date",
      "Service time",
      "Original amount",
      "Paid amount",
      "Amount cleared",
      "Balance owed",
      "Primary staff",
      "Primary manager",
      "Team members",
      "Last rental payment date",
      "Monthly rent",
      "VIS - LO",
      "VIS - TO",
      "VIS - RI",
      "LOCS",
      "LBX",
      "Neighborhood",
      "Plaintiff",
      "SF",
      "Case type",
      "Title",
      "Description",
      "Service location",
      "Service instructions",
      "Internal notes",
      ...customFields.map((f) => f.data.label),
    ]);
    for (const row of rows) {
      const c = row.data,
        a = caseAmounts(c);
      sheet.addRow(
        [
          row.number,
          c.ref,
          c.refId,
          clients.find((x) => x.id === row.client_id)?.data?.company ||
            clients.find((x) => x.id === row.client_id)?.data?.name,
          c.community,
          c.residentName,
          c.residentAddress,
          c.unit,
          c.county,
          c.city,
          c.state,
          c.zip,
          c.propertyType,
          c.attorney,
          c.status,
          c.priority,
          c.serviceDate,
          c.serviceTime,
          a.original,
          a.paid,
          a.cleared,
          a.due,
          names([row.staff_id]),
          names([row.manager_id]),
          names([
            ...new Set(
              [row.staff_id, row.manager_id, ...(c.teamMemberIds || [])].filter(
                Boolean,
              ),
            ),
          ]),
          c.lastPaymentDate,
          c.monthlyRent,
          c.visLO,
          c.visTO,
          c.visRI,
          c.locs,
          c.lbx,
          c.neighborhood,
          c.plaintiff,
          c.squareFeet,
          c.type,
          c.title,
          c.description,
          c.serviceLocation,
          req.user.role === "customer" ? "" : c.instructions,
          req.user.role === "customer" ? "" : c.notes,
          ...customFields.map((f) => c.custom?.[f.id]),
        ].map((x) => x ?? ""),
      );
    }
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF295BB3" },
    };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columnCount },
    };
    sheet.columns.forEach((c) => (c.width = 23));
    for (const col of [19, 20, 21, 22, 27])
      sheet.getColumn(col).numFmt = "$#,##0.00";
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  }
  const filename = `case-reports-${ids.length}.${v.format}`,
    mime =
      v.format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (v.to) {
    assert(
      buffer.length <= 12 * 1024 * 1024,
      422,
      "Report exceeds the email attachment limit. Select fewer cases",
    );
    await pool.query(
      "INSERT INTO legalflow.email_outbox(id,event_key,to_email,subject,text_body,html_body,attachments) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [
        randomUUID(),
        "case.export:" + randomUUID(),
        v.to,
        "LegalFlow case reports",
        "Your requested case reports are attached.",
        "<p>Your requested case reports are attached.</p>",
        JSON.stringify([
          { filename, content: buffer.toString("base64"), contentType: mime },
        ]),
      ],
    );
    return res.json({ ok: true, count: ids.length });
  }
  res
    .type(mime)
    .set("Content-Disposition", `attachment; filename="${filename}"`)
    .send(buffer);
}
