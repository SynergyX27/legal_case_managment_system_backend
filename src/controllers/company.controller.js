import { z } from "zod";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool, transaction } from "../config/database.js";
import { owner } from "../services/access.service.js";
import { assert } from "../utils/errors.js";
import { downloadFile } from "../services/dropbox.service.js";
export const defaults = {
  companyName: "LegalFlow",
  address: "",
  phone: "",
  email: "",
  website: "",
  coverTitle: "Property case report",
  coverText:
    "Prepared for {clientName}.\nA summary of the case and property information for {community}.",
  logoDocumentId: "",
};
export async function profile(db = pool) {
  const r = (
    await db.query(
      "SELECT value FROM legalflow.settings WHERE key='company_profile'",
    )
  ).rows[0];
  return { ...defaults, ...(r ? JSON.parse(r.value) : {}) };
}
export async function get(req, res) {
  res.json(await profile());
}
const text = (n) => z.string().trim().max(n);
const schema = z
  .object({
    companyName: text(200).min(1).optional(),
    address: text(600).optional(),
    phone: text(80).optional(),
    email: z.union([z.literal(""), z.string().email().max(254)]).optional(),
    website: text(250)
      .refine(
        (x) => !x || /^https?:\/\//i.test(x),
        "Use an http or https website URL",
      )
      .optional(),
    coverTitle: text(200).optional(),
    coverText: text(4000).optional(),
    logoDocumentId: text(150).optional(),
    updatedAt: text(50).optional(),
  })
  .strict();
export async function update(req, res) {
  owner(req.user);
  const v = schema.parse(req.body);
  const result = await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-company-profile'))",
    );
    const old = await profile(db);
    if (v.updatedAt)
      assert(
        v.updatedAt === old.updatedAt,
        409,
        "Company details changed. Reload Settings and try again.",
      );
    if (v.logoDocumentId) {
      const d = (
        await db.query("SELECT * FROM legalflow.documents WHERE id=$1", [
          v.logoDocumentId,
        ])
      ).rows[0];
      assert(
        d &&
          !d.case_id &&
          d.state === "ready" &&
          ["image/png", "image/jpeg"].includes(d.mime) &&
          Number(d.bytes) <= 5 * 1024 * 1024,
        422,
        "Choose a company PNG or JPEG logo up to 5 MB",
      );
    }
    const next = { ...old, ...v, updatedAt: new Date().toISOString() };
    await db.query(
      "INSERT INTO legalflow.settings(key,value) VALUES('company_profile',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(next)],
    );
    return next;
  });
  res.json(result);
}
export async function logo(req, res) {
  const p = await profile();
  const d = (
    await pool.query(
      "SELECT * FROM legalflow.documents WHERE id=$1 AND case_id IS NULL AND state='ready'",
      [p.logoDocumentId],
    )
  ).rows[0];
  assert(
    d && ["image/png", "image/jpeg"].includes(d.mime),
    404,
    "Logo unavailable",
  );
  res.type(d.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  await pipeline(Readable.fromWeb(await downloadFile(d.dropbox_path)), res);
}
