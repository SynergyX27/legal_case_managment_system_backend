import { effectivePermissions } from "../services/access.service.js";
import { pool } from "../config/database.js";
export const publicUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  username: row.username,
  phone: row.phone,
  role: row.role,
  managerId: row.manager_id || "",
  customerAccess: row.customer_access || "all",
  workspaceIds: row.workspace_ids || [],
  permissions: effectivePermissions(row),
  permissionOverrides: row.permissions || {},
  status: row.status,
  clientId: row.client_id || undefined,
  title: row.title,
  updatedAt: row.updated_at?.toISOString(),
  accountId: "company",
  lastLogin: row.last_login?.toISOString() || "",
  online: false,
});
export async function findUser(id, db = pool) {
  return (
    await db.query(
      `SELECT u.*,r.permissions AS role_permissions,
 ARRAY(SELECT w.id FROM legalflow.workspaces w JOIN legalflow.workspace_members m ON m.workspace_id=w.id OR m.workspace_id=w.parent_id WHERE m.user_id=u.id AND w.client_id=u.client_id AND NOT w.archived) AS workspace_ids
 FROM legalflow.users u LEFT JOIN legalflow.role_permissions r ON r.role=u.role WHERE u.id=$1 AND u.deleted_at IS NULL`,
      [id],
    )
  ).rows[0];
}
export async function findIdentity(identity, db = pool) {
  return (
    await db.query(
      `SELECT u.*,r.permissions AS role_permissions,
 ARRAY(SELECT w.id FROM legalflow.workspaces w JOIN legalflow.workspace_members m ON m.workspace_id=w.id OR m.workspace_id=w.parent_id WHERE m.user_id=u.id AND w.client_id=u.client_id AND NOT w.archived) AS workspace_ids
 FROM legalflow.users u LEFT JOIN legalflow.role_permissions r ON r.role=u.role WHERE (lower(u.email)=$1 OR lower(u.username)=$1) AND u.deleted_at IS NULL`,
      [identity.toLowerCase()],
    )
  ).rows[0];
}
