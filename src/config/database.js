import pg from "pg";
import { env } from "./env.js";
// Do not put sslmode in DATABASE_URL: pg can override the explicit TLS configuration.
const url = new URL(env.DATABASE_URL);
for (const k of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
  url.searchParams.delete(k);
export const pool = new pg.Pool({
  connectionString: url.toString(),
  ssl: env.DB_SSL_MODE === "disable" ? false : { rejectUnauthorized: true },
  max: env.DB_POOL_MAX,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});
pool.on("error", () =>
  console.error("Unexpected idle database connection error"),
);
export async function transaction(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const v = await fn(c);
    await c.query("COMMIT");
    return v;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
