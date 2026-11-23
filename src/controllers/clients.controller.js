import { randomUUID } from "node:crypto";
import { transaction } from "../config/database.js";
import { assert } from "../utils/errors.js";
import { owner } from "../services/access.service.js";
import { findUser } from "../models/user.model.js";
import { audit } from "../models/audit.model.js";
import { hashPassword } from "../services/password.service.js";
import * as schema from "../validators/schemas.js";
export async function primaryLogin(db, client) {
  return (await db.query("SELECT * FROM legalflow.users WHERE client_id=$1 AND deleted_at IS NULL ORDER BY (id=$2) DESC,(lower(email)=lower($3)) DESC,created_at,id LIMIT 1 FOR UPDATE", [client.id,client.data.primaryUserId || "",client.data.email || ""])).rows[0];
}
async function lockOwner(db, u) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('legalflow-user-access'))");
  const actor=await findUser(u.id,db);
  assert(actor?.role==='owner' && actor.status==='Active',403,'Owner access required');
}
export async function putClient(req, res) {
  owner(req.user);
  const v = schema.clientInput.parse({...req.body,id:req.params.id});
  const username=req.body.username === undefined ? undefined : schema.userInput.shape.username.parse(req.body.username);
  const password=req.body.password ? schema.password.parse(req.body.password) : undefined;
  const hash=password ? await hashPassword(password) : null;
  await transaction(async db => {
    await lockOwner(db,req.user);
    const client=(await db.query("SELECT * FROM legalflow.clients WHERE id=$1 AND data->>'deleted' IS DISTINCT FROM 'true' FOR UPDATE",[v.id])).rows[0];
    assert(client,404,'Customer not found');
    let main=await primaryLogin(db,client);
    const email=v.email.toLowerCase();
    if (!main) {
      assert(username && hash,422,'Enter username and password to complete this customer’s access details');
      const id=randomUUID();
      await db.query("INSERT INTO legalflow.users(id,name,email,username,password_hash,role,client_id,phone) VALUES($1,$2,$3,$4,$5,'customer',$6,$7)",[id,v.name,email,username,hash,v.id,v.phone]);
      main=await findUser(id,db);
    }
    await db.query("UPDATE legalflow.users SET name=$2,email=$3,phone=$4,username=COALESCE($5,username),password_hash=COALESCE($6,password_hash),status=$7,updated_at=now() WHERE id=$1",[main.id,v.name,email,v.phone,username,hash,v.status==='Active'?'Active':'Inactive']);
    if(hash || v.status!=='Active') {
      await db.query("DELETE FROM legalflow.sessions WHERE sess->>'userId'=$1",[main.id]);
      await db.query("DELETE FROM legalflow.mobile_sessions WHERE user_id=$1",[main.id]);
    }
    await db.query("UPDATE legalflow.clients SET data=$2 WHERE id=$1",[v.id,{...client.data,...v,email,company:v.name,accountId:'company',primaryUserId:main.id}]);
    await audit(db,req.user,'customer.updated',v.id);
  });
  res.json({ok:true});
}
export async function deleteClient(req,res) {
  owner(req.user);
  await transaction(async db => {
    await lockOwner(db,req.user);
    const client=(await db.query("SELECT * FROM legalflow.clients WHERE id=$1 AND data->>'deleted' IS DISTINCT FROM 'true' FOR UPDATE",[req.params.id])).rows[0];
    assert(client,404,'Customer not found');
    assert(!(await db.query("SELECT 1 FROM legalflow.cases WHERE client_id=$1 UNION ALL SELECT 1 FROM legalflow.invoices WHERE client_id=$1",[client.id])).rowCount,409,'Remove or reassign this customer’s cases and invoices before deleting the customer');
    assert(!(await db.query("SELECT 1 FROM legalflow.workspaces WHERE client_id=$1",[client.id])).rowCount,409,'Delete this customer’s workspaces and communities first');
    const logins=(await db.query("SELECT id FROM legalflow.users WHERE client_id=$1 AND deleted_at IS NULL FOR UPDATE",[client.id])).rows;
    assert(logins.length<=1,409,'Remove additional customer logins from Workspaces > Customer access first');
    for(const {id} of logins) {
      await db.query("UPDATE legalflow.users SET deleted_at=now(),status='Inactive',updated_at=now() WHERE id=$1",[id]);
      await db.query("DELETE FROM legalflow.sessions WHERE sess->>'userId'=$1",[id]);
      await db.query("DELETE FROM legalflow.mobile_sessions WHERE user_id=$1",[id]);
      await db.query("DELETE FROM legalflow.workspace_members WHERE user_id=$1",[id]);
    }
    await db.query("UPDATE legalflow.clients SET data=data || '{\"deleted\":true,\"status\":\"Inactive\"}'::jsonb WHERE id=$1",[client.id]);
    await audit(db,req.user,'customer.deleted',client.id);
  });res.json({ok:true});
}
