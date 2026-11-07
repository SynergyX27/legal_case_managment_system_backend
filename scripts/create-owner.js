import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { createUserRecord } from "../src/controllers/auth.controller.js";
import { pool } from "../src/config/database.js";
// Run locally or through Render Shell. Never pass passwords as CLI arguments (shell history).
const output = new Writable({
  write(chunk, encoding, done) {
    if (!output.muted) stdout.write(chunk);
    done();
  },
});
output.muted = false;
const rl = createInterface({ input: stdin, output, terminal: true });
try {
  const existing = await pool.query(
    "SELECT 1 FROM legalflow.users WHERE role='owner'",
  );
  if (existing.rowCount)
    throw new Error(
      "An owner already exists. Additional owners must be created in People & access.",
    );
  const name = await rl.question("Owner full name: ");
  const email = await rl.question("Owner email: ");
  const username = await rl.question("Owner username: ");
  stdout.write("Owner password (minimum 10 characters): ");
  output.muted = true;
  const password = await rl.question("");
  output.muted = false;
  stdout.write("\n");
  await createUserRecord(
    { name, email, username, password, role: "owner" },
    { role: "owner", id: null },
  );
  console.log("Owner created. Sign in through the frontend.");
} finally {
  rl.close();
  await pool.end();
}
