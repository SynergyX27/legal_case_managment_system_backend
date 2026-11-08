import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { pool, transaction } from "../src/config/database.js";
import { hashPassword } from "../src/services/password.service.js";

let hidden = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!hidden) stdout.write(chunk);
    done();
  },
});

const rl = createInterface({ input: stdin, output, terminal: true });

async function askPassword(prompt) {
  stdout.write(prompt);
  hidden = true;
  try {
    return await rl.question("");
  } finally {
    hidden = false;
    stdout.write("\n");
  }
}

try {
  const username = (
    await rl.question("Owner username: ")
  ).trim().toLowerCase();

  const result = await pool.query(
    `SELECT id FROM legalflow.users
     WHERE lower(username) = $1
       AND role = 'owner'
       AND status = 'Active'`,
    [username],
  );

  if (result.rowCount !== 1) {
    throw new Error("Active owner username not found. Nothing changed.");
  }

  const password = await askPassword("New password: ");
  const confirmation = await askPassword("Confirm new password: ");

  if (password.length < 10 || password.length > 128) {
    throw new Error("Use a password of 10–128 characters.");
  }

  if (password !== confirmation) {
    throw new Error("Passwords do not match. Nothing changed.");
  }

  const hash = await hashPassword(password);
  const ownerId = result.rows[0].id;

  await transaction(async (db) => {
    const updated = await db.query(
      `UPDATE legalflow.users
       SET password_hash = $2, updated_at = now()
       WHERE id = $1 AND role = 'owner' AND status = 'Active'
       RETURNING id`,
      [ownerId, hash],
    );

    if (updated.rowCount !== 1) {
      throw new Error("Owner access changed. Reset cancelled.");
    }

    await db.query(
      "DELETE FROM legalflow.sessions WHERE sess->>'userId' = $1",
      [ownerId],
    );

    await db.query(
      `INSERT INTO legalflow.audit(user_id, action, record_id)
       VALUES ($1, 'owner.password-reset-cli', $1)`,
      [ownerId],
    );
  });

  console.log("Password reset successfully. Sign in with your new password.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}