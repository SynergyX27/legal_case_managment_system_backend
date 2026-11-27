import {pool,transaction} from "../src/config/database.js";
import {removeFile} from "../src/services/dropbox.service.js";
// Retried uploads refresh their lease. Recheck while locked so active retries are not removed.
try{
 const {rows}=await pool.query("SELECT id FROM legalflow.documents WHERE state='deleting' OR (state='uploading' AND updated_at<now()-interval '1 hour')");
 for(const row of rows){try{await transaction(async db=>{const d=(await db.query("SELECT id,dropbox_path FROM legalflow.documents WHERE id=$1 AND (state='deleting' OR (state='uploading' AND updated_at<now()-interval '1 hour')) FOR UPDATE SKIP LOCKED",[row.id])).rows[0];if(!d)return;await removeFile(d.dropbox_path);await db.query('DELETE FROM legalflow.documents WHERE id=$1',[d.id]);console.log('Reconciled',d.id);});}catch{console.error('Retry required for document',row.id);process.exitCode=1;}}
}finally{await pool.end();}
