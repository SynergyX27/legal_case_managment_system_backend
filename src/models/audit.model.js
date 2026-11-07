import { randomUUID } from "node:crypto";
export async function audit(db, u, action, id) {
  await db.query(
    "INSERT INTO legalflow.audit(user_id,action,record_id) VALUES($1,$2,$3)",
    [u?.id || null, action, id],
  );
}
export async function activity(db, u, caseId, text, kind = "update") {
  await db.query(
    "INSERT INTO legalflow.activities(id,case_id,user_id,text,kind) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), caseId, u.id, text, kind],
  );
}
export async function notify(db, users, kind, text, link) {
  for (const id of [...new Set(users.filter(Boolean))])
    await db.query(
      "INSERT INTO legalflow.notifications(id,user_id,kind,text,link) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), id, kind, text, link],
    );
}
