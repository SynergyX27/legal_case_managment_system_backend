import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("pgAdmin payment update preserves the original schema and is repeatable", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(
      "CREATE SCHEMA legalflow;CREATE TABLE legalflow.migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now());",
    );
    await db.exec(
      await readFile(
        new URL("../migrations/001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.exec(
      "INSERT INTO legalflow.migrations(name) VALUES('001_initial.sql');",
    );
    const update = await readFile(
      new URL("../../Stripe_Payment_Database_Update.sql", import.meta.url),
      "utf8",
    );
    await db.exec(update);
    await db.exec(update);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM legalflow.migrations"))
        .rows[0].n,
      2,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='legalflow'",
        )
      ).rows[0].n,
      21,
    );
  } finally {
    await db.close();
  }
});
