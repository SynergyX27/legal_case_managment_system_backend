import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { pool } from "../config/database.js";
import { findUser, publicUser } from "../models/user.model.js";
import { assert } from "../utils/errors.js";
import { env } from "../config/env.js";
export const csrfToken = (req) =>
  req.session.csrf || (req.session.csrf = randomBytes(32).toString("hex"));
export function csrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  assert(
    origin === new URL(env.APP_ORIGIN).origin,
    403,
    "Request origin is not allowed",
  );
  const sent = Buffer.from(String(req.headers["x-csrf-token"] || "")),
    stored = Buffer.from(csrfToken(req));
  assert(
    sent.length === stored.length && timingSafeEqual(sent, stored),
    403,
    "Security token expired. Refresh and try again",
  );
  next();
}
export async function requireAuth(req, res, next) {
  const user = await findUser(req.session.userId || "");
  assert(user?.status === "Active", 401, "Please sign in");
  req.user = user;
  req.publicUser = publicUser(user);
  next();
}
// Shared database counters survive restarts and work across API instances.
export function authThrottle(limit = 20) {
  return async (req, res, next) => {
    const raw = `${req.ip}:${String(req.body?.identity || req.body?.email || "")
      .toLowerCase()
      .slice(0, 254)}`;
    const key = createHash("sha256").update(raw).digest("hex");
    const { rows } = await pool.query(
      "INSERT INTO legalflow.auth_attempts(key,count,reset_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN legalflow.auth_attempts.reset_at<now() THEN 1 ELSE legalflow.auth_attempts.count+1 END,reset_at=CASE WHEN legalflow.auth_attempts.reset_at<now() THEN now()+interval '15 minutes' ELSE legalflow.auth_attempts.reset_at END RETURNING count",
      [key],
    );
    assert(
      rows[0].count <= limit,
      429,
      "Too many attempts. Try again in 15 minutes",
    );
    next();
  };
}
export async function establishSession(req, user) {
  await new Promise((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve())),
  );
  req.session.userId = user.id;
  csrfToken(req);
  await new Promise((resolve, reject) =>
    req.session.save((e) => (e ? reject(e) : resolve())),
  );
}
