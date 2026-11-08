import { createApp } from "./app.js";
import { pool } from "./config/database.js";
import { env } from "./config/env.js";
await pool.query("SELECT 1 FROM legalflow.migrations LIMIT 1");
await pool.query("SELECT 1 FROM legalflow.invoice_payments LIMIT 1");
const server = createApp().listen(env.PORT, "0.0.0.0", () =>
  console.log(`LegalFlow API listening on port ${env.PORT}`),
);
server.requestTimeout = 120000;
server.headersTimeout = 65000;
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(1), 15000).unref();
  server.close(async () => {
    await pool.end();
    clearTimeout(timer);
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
