import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "../config/database.js";
import { accessibleCase } from "../models/case.model.js";
import { caseScope, owner } from "../services/access.service.js";
import { assert } from "../utils/errors.js";
import { audit, activity } from "../models/audit.model.js";
import { documentView } from "../models/workspace.model.js";
const page = z.object({
  q: z.string().max(150).default(""),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export async function folders(req, res) {
  const v = page.parse(req.query),
    scope = caseScope(req.user),
    n = scope.values.length;
  const args = [...scope.values, v.q, req.user.role === "customer", v.offset];
  const rows = (
    await pool.query(
      `SELECT c.id,c.number,c.data->>'residentName' AS tenant,c.data->>'residentAddress' AS address,c.data->>'community' AS community,(SELECT count(*)::int FROM legalflow.documents d WHERE d.case_id=c.id AND d.state='ready' AND (NOT $${n + 2}::boolean OR d.approval='approved')) AS files FROM legalflow.cases c WHERE (${scope.sql}) AND strpos(lower(concat_ws(' ',c.number,c.data->>'refId',c.data->>'residentName',c.data->>'residentAddress',c.data->>'community')),lower($${n + 1}))>0 ORDER BY c.created_at DESC,c.id LIMIT 31 OFFSET $${n + 3}`,
      args,
    )
  ).rows;
  res.json({ folders: rows.slice(0, 30), hasMore: rows.length > 30 });
}
export async function collections(req, res) {
  const c = await accessibleCase(req.user, req.params.id);
  const rows = (
    await pool.query(
      "SELECT f.*,(SELECT count(*)::int FROM legalflow.documents d WHERE d.case_id=$1 AND d.collection_id=f.id AND d.state='ready' AND ($2::boolean OR d.approval='approved')) AS files,(SELECT count(*)::int FROM legalflow.documents d WHERE d.case_id=$1 AND d.collection_id=f.id AND d.state='ready' AND d.approval='pending' AND $2::boolean) AS pending FROM legalflow.file_collections f ORDER BY f.section,f.position,f.name",
      [c.id, req.user.role !== "customer"],
    )
  ).rows;
  res.json({
    case: {
      id: c.id,
      number: c.number,
      tenant: c.data.residentName,
      address: c.data.residentAddress,
    },
    collections: rows,
  });
}
export async function files(req, res) {
  await accessibleCase(req.user, req.params.id);
  const v = page
    .extend({
      kind: z
        .enum(["", "image", "video", "pdf", "word", "excel", "other"])
        .default(""),
      collectionId: z.string().max(150).default(""),
      approval: z.enum(["", "pending", "approved", "rejected"]).default(""),
    })
    .parse(req.query);
  const rows = (
    await pool.query(
      "SELECT d.*,u.name AS uploader FROM legalflow.documents d JOIN legalflow.users u ON u.id=d.uploaded_by WHERE d.case_id=$1 AND d.state='ready' AND ($2='' OR d.collection_id=$2) AND ($3::boolean OR d.approval='approved') AND strpos(lower(d.name),lower($4))>0 AND ($5='' OR d.approval=$5) AND ($7='' OR d.kind=$7) ORDER BY d.created_at DESC,d.id LIMIT 51 OFFSET $6",
      [
        req.params.id,
        v.collectionId,
        req.user.role !== "customer",
        v.q,
        v.approval,
        v.offset,
        v.kind,
      ],
    )
  ).rows;
  res.json({
    files: rows.slice(0, 50).map(documentView),
    hasMore: rows.length > 50,
  });
}
export async function saveCollection(req, res) {
  owner(req.user);
  const v = z
    .object({
      name: z.string().trim().min(1).max(100),
      section: z.enum(["docs", "visuals"]),
    })
    .parse(req.body);
  const id =
    req.params.id === "new"
      ? randomUUID()
      : z.string().min(1).max(150).parse(req.params.id);
  await transaction(async (db) => {
    await db.query(
      "INSERT INTO legalflow.file_collections(id,name,section) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2,section=$3,updated_at=now()",
      [id, v.name, v.section],
    );
    await audit(db, req.user, "file.collection.saved", id);
  });
  res.json({ ok: true, id });
}
export async function removeCollection(req, res) {
  owner(req.user);
  await transaction(async (db) => {
    const f = (
      await db.query(
        "SELECT * FROM legalflow.file_collections WHERE id=$1 FOR UPDATE",
        [req.params.id],
      )
    ).rows[0];
    assert(f, 404, "Collection not found");
    assert(
      !f.code && !["general-docs", "other-visuals"].includes(f.id),
      409,
      "Keep default and VIS-linked collections; rename them instead",
    );
    assert(
      !(
        await db.query(
          "SELECT 1 FROM legalflow.documents WHERE collection_id=$1 LIMIT 1",
          [f.id],
        )
      ).rowCount,
      409,
      "Move or delete all files from this collection first",
    );
    await db.query("DELETE FROM legalflow.file_collections WHERE id=$1", [
      f.id,
    ]);
    await audit(db, req.user, "file.collection.deleted", f.id);
  });
  res.json({ ok: true });
}
export async function updateFiles(req, res) {
  const v = z
    .object({
      files: z
        .array(
          z.object({
            id: z.string().min(1).max(150),
            updatedAt: z.string().datetime(),
          }),
        )
        .min(1)
        .max(100),
      action: z.enum(["rename", "move", "approve", "reject"]),
      name: z.string().trim().min(1).max(240).optional(),
      collectionId: z.string().max(150).optional(),
    })
    .parse(req.body);
  assert(
    new Set(v.files.map((f) => f.id)).size === v.files.length,
    422,
    "Select each file only once",
  );
  assert(
    v.action !== "rename" ||
      (v.files.length === 1 && v.name && !/[\x00-\x1f\x7f/\\]/.test(v.name)),
    422,
    "Enter a valid filename for one file",
  );
  await transaction(async (db) => {
    if (v.action === "move")
      assert(
        v.collectionId &&
          (
            await db.query(
              "SELECT 1 FROM legalflow.file_collections WHERE id=$1",
              [v.collectionId],
            )
          ).rowCount,
        422,
        "Choose a collection",
      );
    for (const file of [...v.files].sort((a, b) => a.id.localeCompare(b.id))) {
      const d = (
        await db.query(
          "SELECT * FROM legalflow.documents WHERE id=$1 FOR UPDATE",
          [file.id],
        )
      ).rows[0];
      assert(d?.case_id && d.state === "ready", 404, "Case file not found");
      await accessibleCase(req.user, d.case_id, db, { write: true });
      assert(
        new Date(file.updatedAt).getTime() === d.updated_at.getTime(),
        409,
        "A file changed. Refresh the folder before trying again",
      );
      const review = ["approve", "reject"].includes(v.action);
      if (review)
        assert(
          ["owner", "manager"].includes(req.user.role),
          403,
          "Only the owner and assigned managers can review files",
        );
      let name = v.action === "rename" ? v.name : d.name;
      if (v.action === "rename") {
        const ext = d.name.match(/\.[a-zA-Z0-9]+$/)?.[0];
        const requested = name.match(/\.[a-zA-Z0-9]+$/)?.[0];
        assert(
          !ext || !requested || requested.toLowerCase() === ext.toLowerCase(),
          422,
          "Keep the original file extension",
        );
        if (ext && !requested) name += ext;
      }
      const collection = v.action === "move" ? v.collectionId : d.collection_id;
      if (!review && name === d.name && collection === d.collection_id)
        continue;
      await db.query(
        "UPDATE legalflow.documents SET name=$2,collection_id=$3,approval=$4,reviewed_by=$5,reviewed_at=CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,updated_at=now() WHERE id=$1",
        [
          d.id,
          name,
          collection,
          review
            ? v.action === "approve"
              ? "approved"
              : "rejected"
            : "pending",
          review ? req.user.id : null,
        ],
      );
      await audit(db, req.user, "file." + v.action, d.id);
      await activity(
        db,
        req.user,
        d.case_id,
        `${v.action}: ${name}`,
        "attachment",
      );
    }
  });
  res.json({ ok: true, count: v.files.length });
}
