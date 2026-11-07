import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileTypeFromBuffer } from "file-type";
import { pool, transaction } from "../config/database.js";
import { env } from "../config/env.js";
import { assert } from "../utils/errors.js";
import { id as idSchema } from "../validators/schemas.js";
import { owner } from "../services/access.service.js";
import { accessibleCase } from "../models/case.model.js";
import { audit, activity } from "../models/audit.model.js";
import { documentView } from "../models/workspace.model.js";
import * as dropbox from "../services/dropbox.service.js";
async function authorizeDocument(u, id, write = false, db = pool) {
  const d = (
    await db.query("SELECT * FROM legalflow.documents WHERE id=$1", [id])
  ).rows[0];
  assert(d, 404, "Document not found");
  if (d.case_id) await accessibleCase(u, d.case_id, db, { write });
  else owner(u);
  return d;
}
const allowed = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/quicktime",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
]);
export async function upload(req, res) {
  assert(req.file, 422, "Choose a file");
  const caseId = req.body.caseId || null;
  if (caseId) await accessibleCase(req.user, caseId, pool, { write: true });
  else owner(req.user);
  const sniff = await fileTypeFromBuffer(req.file.buffer).catch(() => null);
  const ext = req.file.originalname.split(".").at(-1)?.toLowerCase();
  let mime = sniff?.mime;
  if (!sniff && ["txt", "csv"].includes(ext) && !req.file.buffer.includes(0))
    mime = ext === "csv" ? "text/csv" : "text/plain";
  // Legacy Office files share a compound-container signature. The download is always an attachment.
  if (sniff?.mime === "application/x-cfb" && ["doc", "xls"].includes(ext))
    mime = ext === "doc" ? "application/msword" : "application/vnd.ms-excel";
  assert(
    allowed.has(mime),
    422,
    "Supported files: PDF, images, MP4/MOV, Word, Excel, TXT and CSV",
  );
  const storageStatus = await dropbox.connectionStatus();
  assert(
    storageStatus.connected,
    503,
    "The owner must connect Dropbox in Settings before uploading documents",
  );
  const name =
    req.file.originalname.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 240) ||
    "document";
  const id = idSchema.parse(req.headers["x-upload-id"] || randomUUID());
  const existing = (
    await pool.query(
      "SELECT d.*,u.name AS uploader FROM legalflow.documents d JOIN legalflow.users u ON u.id=d.uploaded_by WHERE d.id=$1",
      [id],
    )
  ).rows[0];
  if (existing) {
    assert(
      existing.uploaded_by === req.user.id && existing.case_id === caseId,
      409,
      "Upload identifier already used",
    );
    assert(
      existing.state === "ready",
      409,
      "This upload is awaiting repair. Ask the owner to reconcile documents before retrying",
    );
    return res.json(documentView(existing));
  }
  const path = `${env.DROPBOX_ROOT}/${caseId ? "cases/" + caseId : "company"}/${id}`;
  const kind = mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime === "application/pdf"
        ? "pdf"
        : mime.includes("word")
          ? "word"
          : mime.includes("sheet") || mime.includes("excel")
            ? "excel"
            : "other";
  // A durable reservation lets the repair script reconcile an interrupted remote upload.
  await pool.query(
    "INSERT INTO legalflow.documents(id,case_id,name,mime,bytes,kind,dropbox_path,uploaded_by,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'uploading')",
    [id, caseId, name, mime, req.file.size, kind, path, req.user.id],
  );
  await dropbox.uploadFile(path, req.file.buffer);
  await transaction(async (db) => {
    await db.query("UPDATE legalflow.documents SET state='ready' WHERE id=$1", [
      id,
    ]);
    await audit(db, req.user, "document.uploaded", id);
    if (caseId)
      await activity(db, req.user, caseId, `Uploaded ${name}`, "attachment");
  });
  const d = (
    await pool.query(
      "SELECT d.*,u.name AS uploader FROM legalflow.documents d JOIN legalflow.users u ON d.uploaded_by=u.id WHERE d.id=$1",
      [id],
    )
  ).rows[0];
  res.status(201).json(documentView(d));
}
export async function content(req, res) {
  const d = await authorizeDocument(req.user, req.params.id);
  assert(d.state === "ready", 409, "This document is not available");
  const stream = await dropbox.downloadFile(d.dropbox_path);
  const inline =
    req.query.download !== "1" &&
    [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
      "video/mp4",
      "video/quicktime",
    ].includes(d.mime);
  res.setHeader("Content-Type", d.mime);
  res.setHeader("Content-Length", d.bytes);
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="document"; filename*=UTF-8''${encodeURIComponent(d.name).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
  );
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, no-store");
  await pipeline(Readable.fromWeb(stream), res);
}
export async function remove(req, res) {
  const d = await authorizeDocument(req.user, req.params.id, true);
  await pool.query(
    "UPDATE legalflow.documents SET state='deleting' WHERE id=$1",
    [d.id],
  );
  try {
    await dropbox.removeFile(d.dropbox_path);
  } catch (e) {
    await pool.query(
      "UPDATE legalflow.documents SET state='ready' WHERE id=$1 AND state='deleting'",
      [d.id],
    );
    throw e;
  }
  await transaction(async (db) => {
    await db.query("DELETE FROM legalflow.documents WHERE id=$1", [d.id]);
    await audit(db, req.user, "document.deleted", d.id);
    if (d.case_id)
      await activity(
        db,
        req.user,
        d.case_id,
        `Deleted ${d.name}`,
        "attachment",
      );
  });
  res.json({ ok: true });
}
export async function status(req, res) {
  owner(req.user);
  res.json(await dropbox.connectionStatus());
}
export async function connect(req, res) {
  owner(req.user);
  assert(
    env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET,
    503,
    "Configure Dropbox app credentials first",
  );
  req.session.dropboxState = {
    value: randomBytes(32).toString("hex"),
    expires: Date.now() + 10 * 60000,
  };
  await new Promise((resolve, reject) =>
    req.session.save((e) => (e ? reject(e) : resolve())),
  );
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  for (const [k, v] of Object.entries({
    client_id: env.DROPBOX_APP_KEY,
    response_type: "code",
    redirect_uri: env.DROPBOX_REDIRECT_URI,
    token_access_type: "offline",
    state: req.session.dropboxState.value,
    scope: "files.content.write files.content.read files.metadata.read",
  }))
    url.searchParams.set(k, v);
  res.json({ url: url.toString() });
}
export async function callback(req, res) {
  owner(req.user);
  const state = req.session.dropboxState;
  delete req.session.dropboxState;
  const sent = Buffer.from(String(req.query.state || ""));
  const expected = Buffer.from(state?.value || "");
  assert(
    state &&
      state.expires > Date.now() &&
      sent.length === expected.length &&
      timingSafeEqual(sent, expected),
    403,
    "Dropbox connection expired. Start again in Settings",
  );
  assert(
    !req.query.error && typeof req.query.code === "string",
    422,
    "Dropbox access was not approved",
  );
  await dropbox.saveGrant(req.query.code);
  await audit(pool, req.user, "dropbox.connected", null);
  res.redirect(`${env.APP_ORIGIN}/settings?dropbox=connected`);
}
