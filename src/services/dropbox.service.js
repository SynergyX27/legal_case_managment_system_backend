import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import { HttpError, assert } from "../utils/errors.js";
let cache = null;
let refreshing = null;
export function encrypt(value) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(env.APP_ENCRYPTION_KEY, "hex"),
      iv,
    );
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes]
    .map((b) => b.toString("base64url"))
    .join(".");
}
function decrypt(value) {
  const [iv, tag, bytes] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.APP_ENCRYPTION_KEY, "hex"),
    iv,
  );
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8");
}
async function refreshToken() {
  if (env.DROPBOX_REFRESH_TOKEN) return env.DROPBOX_REFRESH_TOKEN;
  const row = (
    await pool.query(
      "SELECT value FROM legalflow.settings WHERE key='dropbox_oauth'",
    )
  ).rows[0];
  if (!row) return null;
  const saved = JSON.parse(decrypt(row.value));
  assert(
    saved.appKey === env.DROPBOX_APP_KEY,
    503,
    "Dropbox app changed. Reconnect Dropbox in Settings",
  );
  return saved.refreshToken;
}
export async function connectionStatus() {
  let connected = false;
  try {
    connected = !!(await refreshToken());
  } catch {}
  return {
    configured: !!(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET),
    connected,
    redirectUri: env.DROPBOX_REDIRECT_URI,
    root: env.DROPBOX_ROOT,
    maxFileMb: env.MAX_FILE_MB,
  };
}
export async function tokenRequest(values) {
  assert(
    env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET,
    503,
    "Set the Dropbox app credentials on the server first",
  );
  let response;
  try {
    response = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...values,
        client_id: env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new HttpError(502, "Dropbox could not be reached. Try again");
  }
  if (!response.ok)
    throw new HttpError(
      502,
      "Dropbox authorization failed. Reconnect Dropbox in Settings",
    );
  return response.json();
}
async function accessToken() {
  if (cache && cache.expires > Date.now() + 60000) return cache.token;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = await refreshToken();
    assert(
      refresh,
      503,
      "The owner must connect Dropbox in Settings before uploading documents",
    );
    const v = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
    cache = {
      token: v.access_token,
      expires: Date.now() + v.expires_in * 1000,
    };
    return cache.token;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}
export async function saveGrant(code) {
  const v = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.DROPBOX_REDIRECT_URI,
  });
  assert(
    v.refresh_token,
    502,
    "Dropbox did not return offline access. Reconnect and approve access",
  );
  await pool.query(
    "INSERT INTO legalflow.settings(key,value) VALUES('dropbox_oauth',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
    [
      encrypt(
        JSON.stringify({
          appKey: env.DROPBOX_APP_KEY,
          refreshToken: v.refresh_token,
        }),
      ),
    ],
  );
  cache = null;
}
function apiArg(v) {
  return JSON.stringify(v).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
async function call(endpoint, { arg, body, json = false } = {}) {
  let response;
  const token = await accessToken();
  try {
    response = await fetch(
      `${json ? "https://api.dropboxapi.com/2" : "https://content.dropboxapi.com/2"}/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(json
            ? { "Content-Type": "application/json" }
            : {
                "Dropbox-API-Arg": apiArg(arg),
                ...(body ? { "Content-Type": "application/octet-stream" } : {}),
              }),
        },
        body: json ? JSON.stringify(arg) : body,
        signal: AbortSignal.timeout(60000),
      },
    );
  } catch {
    throw new HttpError(502, "Dropbox request failed. Try again");
  }
  if (!response.ok) {
    const v = await response.json().catch(() => ({}));
    if (response.status === 401) cache = null;
    const error = new HttpError(
      502,
      "Dropbox could not complete this file operation. Check the connection and try again",
    );
    error.notFound =
      response.status === 409 &&
      String(v.error_summary || "").includes("not_found");
    throw error;
  }
  return response;
}
export async function uploadFile(path, buffer) {
  return (
    await call("files/upload", {
      arg: {
        path,
        mode: "add",
        autorename: false,
        mute: true,
        strict_conflict: true,
      },
      body: buffer,
    })
  ).json();
}
export async function removeFile(path) {
  try {
    await call("files/delete_v2", { arg: { path }, json: true });
  } catch (e) {
    if (!e.notFound) throw e;
  }
}
export async function downloadFile(path) {
  return (await call("files/download", { arg: { path } })).body;
}
