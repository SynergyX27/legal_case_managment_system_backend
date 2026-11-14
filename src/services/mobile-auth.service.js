import { randomBytes, randomUUID, createHash } from "node:crypto";
import { pool } from "../config/database.js";
import { findUser, publicUser } from "../models/user.model.js";
import { assert } from "../utils/errors.js";
export const tokenHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export async function issueMobileSession(user) {
  const token = randomBytes(32).toString("base64url"),
    expires = new Date(Date.now() + 30 * 86400000);
  await pool.query(
    "DELETE FROM legalflow.mobile_sessions WHERE expires_at<now()",
  );
  await pool.query(
    "INSERT INTO legalflow.mobile_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,$4)",
    [randomUUID(), tokenHash(token), user.id, expires],
  );
  return { token, expiresAt: expires.toISOString(), user: publicUser(user) };
}
export async function nativeIdentity(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return next();
  assert(
    /^Bearer [A-Za-z0-9_-]{43}$/.test(header),
    401,
    "Invalid mobile session",
  );
  const session = (
    await pool.query(
      "SELECT * FROM legalflow.mobile_sessions WHERE token_hash=$1 AND expires_at>now()",
      [tokenHash(header.slice(7))],
    )
  ).rows[0];
  assert(session, 401, "Mobile session expired. Sign in again");
  const user = await findUser(session.user_id);
  assert(user?.status === "Active", 401, "Please sign in");
  req.nativeSession = session;
  req.user = user;
  req.publicUser = publicUser(user);
  if (Date.now() - session.last_used_at.getTime() > 900000)
    await pool.query(
      "UPDATE legalflow.mobile_sessions SET last_used_at=now() WHERE id=$1",
      [session.id],
    );
  next();
}
