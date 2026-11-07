import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { canMessage } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { notify } from "../models/audit.model.js";
import * as schema from "../validators/schemas.js";
export async function startChat(req, res) {
  const { otherId } = z.object({ otherId: schema.id }).parse(req.body);
  let id;
  await transaction(async (db) => {
    const other = await findUser(otherId, db);
    const cases = (
      await db.query(
        "SELECT client_id,staff_id,manager_id FROM legalflow.cases WHERE client_id=$1 OR client_id=$2",
        [req.user.client_id, other?.client_id],
      )
    ).rows;
    assert(
      canMessage(req.user, other, cases),
      403,
      "You may only message your assigned case team or an owner",
    );
    const pair = [req.user.id, otherId].sort().join(":");
    id = (
      await db.query(
        "INSERT INTO legalflow.conversations(id,pair) VALUES($1,$2) ON CONFLICT(pair) DO UPDATE SET pair=$2 RETURNING id",
        [randomUUID(), pair],
      )
    ).rows[0].id;
    for (const uid of [req.user.id, otherId])
      await db.query(
        "INSERT INTO legalflow.conversation_members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, uid],
      );
  });
  res.json({ id });
}
async function authorizeConversation(req, db) {
  const members = (
    await db.query(
      "SELECT u.* FROM legalflow.users u JOIN legalflow.conversation_members m ON m.user_id=u.id WHERE m.conversation_id=$1",
      [req.params.id],
    )
  ).rows;
  assert(
    members.length === 2 && members.some((u) => u.id === req.user.id),
    404,
    "Conversation not found",
  );
  const other = members.find((u) => u.id !== req.user.id);
  const cases = (
    await db.query(
      "SELECT client_id,staff_id,manager_id FROM legalflow.cases WHERE client_id=$1 OR client_id=$2",
      [req.user.client_id, other.client_id],
    )
  ).rows;
  assert(
    canMessage(req.user, other, cases),
    403,
    "You no longer have access to this conversation",
  );
  return other;
}
export async function sendMessage(req, res) {
  const v = schema.messageInput.parse(req.body);
  await transaction(async (db) => {
    const other = await authorizeConversation(req, db);
    await db.query(
      "INSERT INTO legalflow.messages(id,conversation_id,user_id,text) VALUES($1,$2,$3,$4)",
      [randomUUID(), req.params.id, req.user.id, v.text],
    );
    await notify(
      db,
      [other.id],
      "message",
      `${req.user.name} sent a message`,
      "/communications",
    );
  });
  res.status(201).json({ ok: true });
}
export async function readChat(req, res) {
  await transaction(async (db) => {
    await authorizeConversation(req, db);
    const { lastMessageId } = z
      .object({ lastMessageId: schema.id })
      .parse(req.body);
    assert(
      (
        await db.query(
          "SELECT 1 FROM legalflow.messages WHERE id=$1 AND conversation_id=$2",
          [lastMessageId, req.params.id],
        )
      ).rowCount,
      422,
      "Message not found",
    );
    await db.query(
      "UPDATE legalflow.conversation_members SET last_read_id=$3 WHERE conversation_id=$1 AND user_id=$2",
      [req.params.id, req.user.id, lastMessageId],
    );
  });
  res.json({ ok: true });
}
