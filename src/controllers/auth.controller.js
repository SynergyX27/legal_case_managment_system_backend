import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "../config/database.js";
import { findIdentity, findUser, publicUser } from "../models/user.model.js";
import { userInput, password } from "../validators/schemas.js";
import { hashPassword, verifyPassword } from "../services/password.service.js";
import { assert } from "../utils/errors.js";
import { csrfToken, establishSession } from "../middleware/auth.js";
import { audit } from "../models/audit.model.js";
export async function createUserRecord(input, actor = null) {
  const data = userInput.parse(input);
  assert(
    actor?.role === "owner" || data.role === "customer",
    403,
    "Public registration only creates customers",
  );
  const hash = await hashPassword(data.password);
  return transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))",
    );
    if (data.role === "staff") {
      assert(data.managerId, 422, "Assign this staff member to a manager");
      assert(
        (
          await db.query(
            "SELECT 1 FROM legalflow.users WHERE id=$1 AND role='manager' AND status='Active'",
            [data.managerId],
          )
        ).rowCount,
        422,
        "Select an active manager",
      );
    }
    if (data.role === "owner" && !actor?.id) {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('legalflow-first-owner'))",
      );
      assert(
        !(await db.query("SELECT 1 FROM legalflow.users WHERE role='owner'"))
          .rowCount,
        409,
        "An owner already exists. Create additional owners in People & access",
      );
    }
    let clientId = null;
    const id = randomUUID();
    if (data.role === "customer") {
      clientId = data.clientId || randomUUID();
      if (data.clientId) {
        assert(
          actor?.role === "owner",
          403,
          "Only the owner can link an existing customer",
        );
        const old = await db.query(
          "SELECT * FROM legalflow.clients WHERE id=$1 FOR UPDATE",
          [clientId],
        );
        assert(old.rowCount, 422, "Customer not found");
        await db.query(
          "UPDATE legalflow.clients SET data=data||$2::jsonb WHERE id=$1",
          [
            clientId,
            JSON.stringify({
              name: data.name,
              company: data.name,
              email: data.email,
              phone: data.phone,
              address: data.address,
            }),
          ],
        );
      } else
        await db.query("INSERT INTO legalflow.clients(id,data) VALUES($1,$2)", [
          clientId,
          {
            id: clientId,
            name: data.name,
            company: data.name,
            email: data.email,
            phone: data.phone,
            address: data.address,
            status: "Active",
            accountId: "company",
          },
        ]);
    }
    await db.query(
      "INSERT INTO legalflow.users(id,name,email,username,password_hash,role,client_id,phone,title,manager_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        data.name,
        data.email,
        data.username,
        hash,
        data.role,
        clientId,
        data.phone,
        data.title,
        data.role === "staff" ? data.managerId : null,
      ],
    );
    await audit(db, actor, "user.created", id);
    return findUser(id, db);
  });
}
export async function session(req, res) {
  const user = req.session.userId ? await findUser(req.session.userId) : null;
  res.json({
    user: user?.status === "Active" ? publicUser(user) : null,
    csrfToken: csrfToken(req),
  });
}
export async function login(req, res) {
  const data = z
    .object({
      identity: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(128),
    })
    .parse(req.body);
  const u = await findIdentity(data.identity);
  const dummy = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);
  const valid = await verifyPassword(data.password, u?.password_hash || dummy);
  assert(
    valid && u?.status === "Active",
    401,
    "Incorrect username or password",
  );
  await establishSession(req, u);
  await pool.query("UPDATE legalflow.users SET last_login=now() WHERE id=$1", [
    u.id,
  ]);
  res.json({ user: publicUser(u), csrfToken: csrfToken(req) });
}
export async function register(req, res) {
  const u = await createUserRecord({
    ...req.body,
    role: "customer",
    clientId: "",
  });
  await establishSession(req, u);
  res.status(201).json({ user: publicUser(u), csrfToken: csrfToken(req) });
}
export async function logout(req, res) {
  await new Promise((resolve, reject) =>
    req.session.destroy((e) => (e ? reject(e) : resolve())),
  );
  res.clearCookie("legalflow.sid", {
    path: "/api",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  res.json({ ok: true });
}
export async function profile(req, res) {
  const v = z
    .object({
      name: z.string().trim().min(2).max(250),
      phone: z.string().max(250).default(""),
      currentPassword: z.string().max(128).optional(),
      newPassword: password.optional(),
    })
    .parse(req.body);
  let hash = null;
  if (v.newPassword) {
    assert(
      await verifyPassword(v.currentPassword || "", req.user.password_hash),
      422,
      "Current password is incorrect",
    );
    hash = await hashPassword(v.newPassword);
  }
  await transaction(async (db) => {
    await db.query(
      "UPDATE legalflow.users SET name=$2,phone=$3,password_hash=COALESCE($4,password_hash),updated_at=now() WHERE id=$1",
      [req.user.id, v.name, v.phone, hash],
    );
    if (req.user.client_id)
      await db.query(
        "UPDATE legalflow.clients SET data=data||$2::jsonb WHERE id=$1",
        [
          req.user.client_id,
          JSON.stringify({ name: v.name, company: v.name, phone: v.phone }),
        ],
      );
    if (hash)
      await db.query(
        "DELETE FROM legalflow.sessions WHERE sess->>'userId'=$1 AND sid<>$2",
        [req.user.id, req.sessionID],
      );
    await audit(db, req.user, "profile.updated", req.user.id);
  });
  res.json({ ok: true });
}
