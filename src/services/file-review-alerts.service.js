import { createHash } from "node:crypto";
import { visible, can } from "./access.service.js";
export const reviewLink = (caseId, collectionId) =>
  `/documents?caseId=${encodeURIComponent(caseId)}&collectionId=${encodeURIComponent(collectionId)}&approval=pending`;
// Called within the file mutation transaction; stable IDs group a batch into one alert per collection/reviewer.
export async function syncReviewAlerts(db, groups, { bump = false } = {}) {
  const unique = [
    ...new Map(
      groups
        .filter((g) => g.caseId && g.collectionId)
        .map((g) => [g.caseId + "\0" + g.collectionId, g]),
    ).entries(),
  ].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, g] of unique) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "file-review:" + key.replaceAll("\0", ":"),
    ]);
    const c = (
      await db.query("SELECT * FROM legalflow.cases WHERE id=$1", [g.caseId])
    ).rows[0];
    const collection = (
      await db.query(
        "SELECT name FROM legalflow.file_collections WHERE id=$1",
        [g.collectionId],
      )
    ).rows[0];
    const count = Number(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM legalflow.documents WHERE case_id=$1 AND collection_id=$2 AND state='ready' AND approval='pending'",
          [g.caseId, g.collectionId],
        )
      ).rows[0].n,
    );
    const link = reviewLink(g.caseId, g.collectionId);
    const users =
      c && collection
        ? (
            await db.query(
              "SELECT u.*,COALESCE(p.permissions,r.permissions) AS role_permissions FROM legalflow.users u LEFT JOIN legalflow.role_permissions r ON r.role=u.role LEFT JOIN legalflow.role_profiles p ON p.id=u.role_profile WHERE u.deleted_at IS NULL AND u.status='Active' AND u.role<>'customer'",
            )
          ).rows.filter(
            (u) =>
              visible(u, c) && can(u, "files.approve") && can(u, "files.view"),
          )
        : [];
    await db.query(
      "DELETE FROM legalflow.notifications WHERE kind='file-review' AND link=$1 AND ($2::boolean OR NOT(user_id=ANY($3::text[])))",
      [link, !count, users.map((u) => u.id)],
    );
    if (!count || !c || !collection) continue;
    const text = `${count} file${count === 1 ? "" : "s"} awaiting approval · ${c.number} / ${collection.name}`;
    for (const u of users) {
      const id =
        "review-" +
        createHash("sha256")
          .update(u.id + "\0" + key)
          .digest("hex");
      await db.query(
        "INSERT INTO legalflow.notifications(id,user_id,kind,text,link) VALUES($1,$2,'file-review',$3,$4) ON CONFLICT(id) DO UPDATE SET text=$3,link=$4,read=CASE WHEN $5::boolean THEN false ELSE legalflow.notifications.read END,at=CASE WHEN $5::boolean THEN now() ELSE legalflow.notifications.at END",
        [id, u.id, text, link, bump],
      );
    }
  }
}
