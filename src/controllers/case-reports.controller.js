import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../config/database.js";
import { caseScope } from "../services/access.service.js";
import { preferenceInput } from "../validators/schemas.js";
import {
  selectReportCases,
  caseReportHtml,
} from "../services/case-report.service.js";
import { assert } from "../utils/errors.js";
import { env } from "../config/env.js";
const filtersSchema =
  preferenceInput.shape.savedViews.unwrap().element.shape.filters;
export async function email(req, res) {
  const v = z
    .object({
      to: z.string().email().max(254),
      filters: filtersSchema,
      statuses: z.array(z.string().max(40)).max(10),
    })
    .parse(req.body);
  assert(
    env.SMTP_ENABLED,
    503,
    "Email delivery is disabled. Ask the owner to configure email settings.",
  );
  const scope = caseScope(req.user);
  const rows = (
    await pool.query(
      `SELECT c.*, cl.data AS customer_data, staff.name AS staff_name FROM legalflow.cases c JOIN legalflow.clients cl ON cl.id=c.client_id LEFT JOIN legalflow.users staff ON staff.id=c.staff_id WHERE ${scope.sql} ORDER BY c.number`,
      scope.values,
    )
  ).rows;
  const cases = selectReportCases(
    rows.map((r) => ({
      ...r.data,
      searchCustomer: [
        r.customer_data?.name,
        r.customer_data?.company,
        r.staff_name,
      ].join(" "),
      number: r.number,
      clientId: r.client_id,
      staffId: r.staff_id,
      managerId: r.manager_id,
    })),
    v.filters,
    req.user.id,
  );
  assert(cases.length <= 5000, 422, "Narrow the report to at most 5,000 cases");
  const html = caseReportHtml(cases, v.filters, v.statuses);
  await pool.query(
    "INSERT INTO legalflow.email_outbox(id,event_key,to_email,subject,text_body,html_body) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      "case.report:" + randomUUID(),
      v.to,
      "LegalFlow case files report",
      html.replace(/<[^>]+>/g, " "),
      html,
    ],
  );
  res.json({ ok: true, count: cases.length });
}
