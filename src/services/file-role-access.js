import { can } from "./access.service.js";
import { assert } from "../utils/errors.js";
export async function collectionAccess(u, id, db) {
  if (!u.role_profile || u.role === "customer" || can(u, "files.legal")) return;
  const f = (
    await db.query(
      "SELECT section FROM legalflow.file_collections WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert(
    f?.section === "visuals",
    403,
    "This role can access visual collections only",
  );
}
export function fileEditAccess(u, d) {
  if (u.role_profile && !can(u, "files.approve"))
    assert(
      d.uploaded_by === u.id && d.approval === "pending",
      403,
      "Only your own pending uploads can be changed",
    );
}
