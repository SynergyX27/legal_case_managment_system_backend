import { z } from "zod";
import { pool, transaction } from "../config/database.js";
import { findIdentity, findUser } from "../models/user.model.js";
import { verifyPassword } from "../services/password.service.js";
import { createUserRecord } from "./auth.controller.js";
import {
  issueMobileSession,
  tokenHash,
} from "../services/mobile-auth.service.js";
import { assert } from "../utils/errors.js";
import { owner } from "../services/access.service.js";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import * as dropbox from "../services/dropbox.service.js";
import { audit } from "../models/audit.model.js";
export async function login(req, res) {
  const v = z
    .object({
      identity: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(128),
    })
    .parse(req.body);
  const user = await findIdentity(v.identity);
  const dummy = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);
  const valid = await verifyPassword(v.password, user?.password_hash || dummy);
  assert(
    valid && user?.status === "Active",
    401,
    "Incorrect username or password",
  );
  await pool.query("UPDATE legalflow.users SET last_login=now() WHERE id=$1", [
    user.id,
  ]);
  res.json(await issueMobileSession(user));
}
export async function register(req, res) {
  const user = await createUserRecord({
    ...req.body,
    role: "customer",
    clientId: "",
  });
  res.status(201).json(await issueMobileSession(user));
}
export async function logout(req, res) {
  assert(req.nativeSession, 401, "Mobile session required");
  await pool.query("DELETE FROM legalflow.mobile_sessions WHERE id=$1", [
    req.nativeSession.id,
  ]);
  res.json({ ok: true });
}
export async function dropboxConnect(req, res) {
  owner(req.user);
  assert(req.nativeSession, 401, "Mobile session required");
  assert(
    env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET,
    503,
    "Configure Dropbox on the backend first",
  );
  const state = "mobile_" + randomBytes(32).toString("base64url");
  await pool.query(
    "DELETE FROM legalflow.mobile_oauth_states WHERE expires_at<now()",
  );
  await pool.query(
    "INSERT INTO legalflow.mobile_oauth_states(state_hash,session_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
    [tokenHash(state), req.nativeSession.id],
  );
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  for (const [k, v] of Object.entries({
    client_id: env.DROPBOX_APP_KEY,
    response_type: "code",
    redirect_uri: env.DROPBOX_REDIRECT_URI,
    token_access_type: "offline",
    state,
    scope: "files.content.write files.content.read files.metadata.read",
  }))
    url.searchParams.set(k, v);
  res.json({ url: url.toString() });
}
export async function dropboxCallback(req, res, next) {
  if (!String(req.query.state || "").startsWith("mobile_")) return next();
  const user = await transaction(async (db) => {
    const state = (
      await db.query(
        "DELETE FROM legalflow.mobile_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING session_id",
        [tokenHash(String(req.query.state))],
      )
    ).rows[0];
    assert(
      state,
      403,
      "Mobile Dropbox connection expired. Start again in the app",
    );
    const session = (
      await db.query(
        "SELECT user_id FROM legalflow.mobile_sessions WHERE id=$1 AND expires_at>now()",
        [state.session_id],
      )
    ).rows[0];
    assert(session, 401, "Sign in again before connecting Dropbox");
    return findUser(session.user_id, db);
  });
  owner(user);
  assert(user?.status === "Active", 403, "Active owner required");
  if (req.query.error)
    return res.redirect(
      `${env.MOBILE_APP_SCHEME}://integration/dropbox?status=cancelled`,
    );
  assert(
    typeof req.query.code === "string",
    422,
    "Missing Dropbox authorization code",
  );
  await dropbox.saveGrant(req.query.code);
  await audit(pool, user, "dropbox.connected", null);
  res.redirect(
    `${env.MOBILE_APP_SCHEME}://integration/dropbox?status=connected`,
  );
}
export function paymentReturn(req, res) {
  const invoiceId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .parse(req.query.invoiceId);
  const status = z.enum(["success", "cancelled"]).parse(req.query.payment);
  // This only returns to the app. The authenticated payment-status endpoint verifies payment.
  res.redirect(
    `${env.MOBILE_APP_SCHEME}://payment?invoiceId=${encodeURIComponent(invoiceId)}&payment=${status}`,
  );
}
