import { pool } from "../config/database.js";
export const publicUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  username: row.username,
  phone: row.phone,
  role: row.role,
  status: row.status,
  clientId: row.client_id || undefined,
  title: row.title,
  accountId: "company",
  lastLogin: row.last_login?.toISOString() || "",
  online: false,
});
export async function findUser(id, db = pool) {
  return (await db.query("SELECT * FROM legalflow.users WHERE id=$1", [id]))
    .rows[0];
}
export async function findIdentity(identity, db = pool) {
  return (
    await db.query(
      "SELECT * FROM legalflow.users WHERE lower(email)=$1 OR lower(username)=$1",
      [identity.toLowerCase()],
    )
  ).rows[0];
}
