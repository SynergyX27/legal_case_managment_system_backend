import { readdir, readFile } from "node:fs/promises";
import { pool, transaction } from "../src/config/database.js";
export async function migrate() {
  await transaction(async (c) => {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('legalflow-migrations'))",
    );
    await c.query("CREATE SCHEMA IF NOT EXISTS legalflow");
    await c.query(
      "CREATE TABLE IF NOT EXISTS legalflow.migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
    );
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        (
          await c.query("SELECT 1 FROM legalflow.migrations WHERE name=$1", [
            name,
          ])
        ).rowCount
      )
        continue;
      await c.query(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO legalflow.migrations(name) VALUES($1)", [
        name,
      ]);
      console.log("Applied", name);
    }
  });
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    await migrate();
  } finally {
    await pool.end();
  }
}
