import { pool } from "../src/config/database.js";
import { removeFile } from "../src/services/dropbox.service.js";
// Retry incomplete deletions and remove abandoned upload reservations older than an hour.
try {
  const { rows } = await pool.query(
    "SELECT id,dropbox_path FROM legalflow.documents WHERE state='deleting' OR (state='uploading' AND created_at<now()-interval '1 hour')",
  );
  for (const d of rows) {
    try {
      await removeFile(d.dropbox_path);
      await pool.query("DELETE FROM legalflow.documents WHERE id=$1", [d.id]);
      console.log("Reconciled", d.id);
    } catch {
      console.error("Retry required for document", d.id);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
