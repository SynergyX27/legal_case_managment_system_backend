import { can } from "./access.service.js";
import { assert } from "../utils/errors.js";
const legal = [
  "attorney",
  "court",
  "plaintiff",
  "notes",
  "description",
  "caseNumber",
  "number",
  "ref",
  "custom",
];
const operations = [
  "serviceDate",
  "serviceTime",
  "serviceLocation",
  "instructions",
  "status",
  "priority",
  "visLO",
  "visTO",
  "visRI",
  "locs",
  "lbx",
];
export function protectCaseFields(u, old, input) {
  if (!old) return;
  if (can(u, "cases.edit")) return;
  if (
    !can(u, "cases.edit_operations") &&
    input.status !== undefined &&
    input.status !== old.data.status
  )
    assert(
      !["Completed", "Cancelled"].includes(input.status),
      403,
      "A manager must close or cancel the case",
    );
  const allowed = new Set([
    ...(can(u, "cases.edit_legal") ? legal : []),
    ...(can(u, "cases.edit_operations") ? operations : []),
    ...(can(u, "cases.update_progress") ? ["status"] : []),
  ]);
  assert(allowed.size, 403, "Case editing permission required");
  for (const [k, v] of Object.entries(input)) {
    if (["id", "updatedAt"].includes(k) || allowed.has(k)) continue;
    const previous =
      old.data[k] ??
      {
        clientId: old.client_id,
        staffId: old.staff_id || "",
        managerId: old.manager_id || "",
        workspaceId: old.workspace_id || "",
      }[k];
    assert(
      (previous === undefined && [undefined, null, "", 0, false].includes(v)) ||
        JSON.stringify(previous) === JSON.stringify(v),
      403,
      `Your role cannot change ${k}`,
    );
  }
}
