import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "../config/database.js";
import { owner, permit } from "../services/access.service.js";
import { assert } from "../utils/errors.js";
import { audit } from "../models/audit.model.js";
import { documentView } from "../models/workspace.model.js";
import * as documents from "./documents.controller.js";
const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (s) => !/[\x00-\x1f\x7f/\\]/.test(s),
    "Use a folder name without slashes or control characters",
  );
const version = z.string().datetime();
const page = z.object({
  q: z.string().trim().max(150).default(""),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
function authorize(u) {
  owner(u);
  permit(u, "company.manage");
}
async function lock(db) {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext('legalflow-company-folders'))",
  );
}
export async function folders(req, res) {
  authorize(req.user);
  const v = page.parse(req.query);
  const rows = (
    await pool.query(
      "SELECT f.*,(SELECT count(*)::int FROM legalflow.documents d WHERE d.company_folder_id=f.id AND d.case_id IS NULL AND d.state='ready') AS files FROM legalflow.company_folders f WHERE strpos(lower(f.name),lower($1))>0 ORDER BY lower(f.name),f.id LIMIT 51 OFFSET $2",
      [v.q, v.offset],
    )
  ).rows;
  const unfiled = (
    await pool.query(
      "SELECT count(*)::int AS n FROM legalflow.documents WHERE case_id IS NULL AND company_folder_id IS NULL AND state='ready'",
    )
  ).rows[0].n;
  res.json({
    folders: rows
      .slice(0, 50)
      .map((f) => ({
        id: f.id,
        name: f.name,
        files: f.files,
        updatedAt: f.updated_at.toISOString(),
      })),
    unfiled,
    hasMore: rows.length > 50,
  });
}
export async function saveFolder(req, res) {
  authorize(req.user);
  const v = z
    .object({ name, updatedAt: version.optional() })
    .strict()
    .parse(req.body);
  let id = req.params.id || randomUUID();
  await transaction(async (db) => {
    await lock(db);
    const old = (
      await db.query(
        "SELECT * FROM legalflow.company_folders WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    assert(!req.params.id || old, 404, "Folder not found");
    if (old)
      assert(
        v.updatedAt &&
          new Date(v.updatedAt).getTime() === old.updated_at.getTime(),
        409,
        "Folder changed. Refresh and try again",
      );
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.company_folders WHERE lower(name)=lower($1) AND id<>$2",
          [v.name, id],
        )
      ).rowCount,
      409,
      "A company folder already uses this name",
    );
    await db.query(
      "INSERT INTO legalflow.company_folders(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=$2,updated_at=now()",
      [id, v.name],
    );
    await audit(db, req.user, "company.folder.saved", id);
  });
  res.json({ id });
}
export async function removeFolder(req, res) {
  authorize(req.user);
  const v = z.object({ updatedAt: version }).strict().parse(req.body);
  await transaction(async (db) => {
    await lock(db);
    const old = (
      await db.query(
        "SELECT * FROM legalflow.company_folders WHERE id=$1 FOR UPDATE",
        [req.params.id],
      )
    ).rows[0];
    assert(old, 404, "Folder not found");
    assert(
      new Date(v.updatedAt).getTime() === old.updated_at.getTime(),
      409,
      "Folder changed. Refresh and try again",
    );
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.documents WHERE company_folder_id=$1 LIMIT 1",
          [old.id],
        )
      ).rowCount,
      409,
      "Move or delete every file before deleting this folder. Uploads or file cleanup may still be in progress",
    );
    await db.query("DELETE FROM legalflow.company_folders WHERE id=$1", [
      old.id,
    ]);
    await audit(db, req.user, "company.folder.deleted", old.id);
  });
  res.json({ ok: true });
}
export async function files(req, res) {
  authorize(req.user);
  const v = page
    .extend({ folderId: z.string().max(100).default("") })
    .parse(req.query);
  const folder = v.folderId
    ? (
        await pool.query(
          "SELECT * FROM legalflow.company_folders WHERE id=$1",
          [v.folderId],
        )
      ).rows[0]
    : null;
  assert(!v.folderId || folder, 404, "Folder not found");
  const rows = (
    await pool.query(
      "SELECT d.*,u.name AS uploader FROM legalflow.documents d JOIN legalflow.users u ON u.id=d.uploaded_by WHERE d.case_id IS NULL AND d.state='ready' AND COALESCE(d.company_folder_id,'')=$1 AND strpos(lower(d.name),lower($2))>0 ORDER BY d.created_at DESC,d.id LIMIT 51 OFFSET $3",
      [v.folderId, v.q, v.offset],
    )
  ).rows;
  res.json({
    folder: folder
      ? {
          id: folder.id,
          name: folder.name,
          updatedAt: folder.updated_at.toISOString(),
        }
      : null,
    files: rows.slice(0, 50).map(documentView),
    hasMore: rows.length > 50,
  });
}
export async function editFile(req, res) {
  authorize(req.user);
  const v = z
    .object({
      updatedAt: version,
      name: z.string().trim().min(1).max(240).optional(),
      folderId: z.string().max(100).optional(),
    })
    .strict()
    .refine(
      (v) => v.name !== undefined || v.folderId !== undefined,
      "Choose a change",
    )
    .parse(req.body);
  await transaction(async (db) => {
    await lock(db);
    const d = (
      await db.query(
        "SELECT * FROM legalflow.documents WHERE id=$1 FOR UPDATE",
        [req.params.id],
      )
    ).rows[0];
    assert(
      d && !d.case_id && d.state === "ready",
      404,
      "Company file not found",
    );
    assert(
      new Date(v.updatedAt).getTime() === d.updated_at.getTime(),
      409,
      "File changed. Refresh before saving",
    );
    if (v.name) {
      assert(!/[\x00-\x1f\x7f/\\]/.test(v.name), 422, "Enter a valid filename");
      assert(
        (d.name.match(/\.[^.]+$/)?.[0].toLowerCase() || "") ===
          (v.name.match(/\.[^.]+$/)?.[0].toLowerCase() || ""),
        422,
        "Keep the original file extension",
      );
    }
    const folderId =
      v.folderId === undefined ? d.company_folder_id : v.folderId || null;
    if (folderId)
      assert(
        (
          await db.query(
            "SELECT 1 FROM legalflow.company_folders WHERE id=$1",
            [folderId],
          )
        ).rowCount,
        422,
        "Choose an existing folder",
      );
    await db.query(
      "UPDATE legalflow.documents SET company_folder_id=$2,name=$3,updated_at=now() WHERE id=$1",
      [d.id, folderId, v.name || d.name],
    );
    await audit(db, req.user, "company.file.updated", d.id);
  });
  res.json({ ok: true });
}
async function companyDocument(req) {
  authorize(req.user);
  const d = (
    await pool.query("SELECT case_id FROM legalflow.documents WHERE id=$1", [
      req.params.id,
    ])
  ).rows[0];
  assert(d && d.case_id === null, 404, "Company file not found");
}
export async function content(req, res) {
  await companyDocument(req);
  return documents.content(req, res);
}
export async function removeFile(req, res) {
  await companyDocument(req);
  return documents.remove(req, res);
}
export async function upload(req, res) {
  authorize(req.user);
  assert(
    !req.body?.caseId && !req.body?.collectionId && !req.body?.replaceId,
    422,
    "Company uploads cannot target case files",
  );
  return documents.upload(req, res);
}
