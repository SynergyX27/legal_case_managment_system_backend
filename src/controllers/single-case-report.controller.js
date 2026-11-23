import { z } from "zod";
import { randomUUID } from "node:crypto";
import { singleCasePdf } from "../services/single-case-report.service.js";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import { assert } from "../utils/errors.js";
export async function pdf(req, res) {
  const photoId = z.string().max(150).optional().parse(req.query.photoId);
  const r = await singleCasePdf(req.user, req.params.id, photoId);
  res.type("application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${r.filename}"`);
  res.send(r.buffer);
}
export async function email(req, res) {
  const v = z
    .object({
      to: z.string().email().max(254),
      photoId: z.string().max(150).optional(),
    })
    .parse(req.body);
  assert(env.SMTP_ENABLED, 503, "Email delivery is disabled");
  const r = await singleCasePdf(req.user, req.params.id, v.photoId);
  assert(
    r.buffer.length <= 12 * 1024 * 1024,
    422,
    "Report is too large to email. Select a smaller photo.",
  );
  await pool.query(
    "INSERT INTO legalflow.email_outbox(id,event_key,to_email,subject,text_body,html_body,attachments) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [
      randomUUID(),
      "single-case.report:" + randomUUID(),
      v.to,
      "Case report",
      "Your requested case report is attached.",
      "<p>Your requested case report is attached.</p>",
      JSON.stringify([
        {
          filename: r.filename,
          content: r.buffer.toString("base64"),
          contentType: "application/pdf",
        },
      ]),
    ],
  );
  res.json({ ok: true });
}
