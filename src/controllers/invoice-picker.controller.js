import { z } from "zod";
import { pool } from "../config/database.js";
import { biller, caseScope } from "../services/access.service.js";
const input = z.object({
  kind: z.enum(["customers", "communities", "dates", "cases"]).default("cases"),
  q: z.string().trim().max(150).default(""),
  clientId: z.string().max(150).default(""),
  workspaceId: z.string().max(150).default(""),
  serviceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(""))
    .default(""),
  mode: z.enum(["single", "group"]).default("single"),
  unbilled: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export async function search(req, res) {
  biller(req.user);
  const v = input.parse(req.query),
    scope = caseScope(req.user),
    args = [...scope.values],
    where = [scope.sql];
  const bind = (x) => {
    args.push(x);
    return `$${args.length}`;
  };
  if (v.clientId) where.push(`c.client_id=${bind(v.clientId)}`);
  if (v.workspaceId)
    where.push(
      v.workspaceId === "unassigned"
        ? "c.workspace_id IS NULL"
        : `c.workspace_id=${bind(v.workspaceId)}`,
    );
  if (v.serviceDate)
    where.push(`c.data->>'serviceDate'=${bind(v.serviceDate)}`);
  if (v.mode === "group")
    where.push(
      "c.data->>'propertyType'='APT'",
      "c.workspace_id IS NOT NULL",
      "EXISTS (SELECT 1 FROM legalflow.workspaces gw WHERE gw.id=c.workspace_id AND gw.kind='community' AND NOT gw.archived)",
      "NULLIF(c.data->>'serviceDate','') IS NOT NULL",
    );
  const invoiceLink =
    "(i.case_id=c.id OR (i.data->'caseIds') ? c.id) AND i.deleted_at IS NULL";
  if (v.unbilled === "true")
    where.push(
      `NOT EXISTS (SELECT 1 FROM legalflow.invoices i WHERE ${invoiceLink})`,
    );
  const escaped = v.q.replace(/[\\%_]/g, "\\$&"),
    like = () => bind(`%${escaped}%`);
  let query, params;
  if (v.kind === "customers") {
    if (v.q)
      where.push(
        `concat_ws(' ',cl.data->>'name',cl.data->>'company',cl.data->>'email') ILIKE ${like()}`,
      );
    query = `SELECT DISTINCT cl.id,cl.data->>'name' AS name,cl.data->>'company' AS company FROM legalflow.clients cl JOIN legalflow.cases c ON c.client_id=cl.id WHERE cl.data->>'deleted' IS DISTINCT FROM 'true' AND ${where.join(" AND ")}`;
  } else if (v.kind === "communities") {
    if (v.q) where.push(`w.name ILIKE ${like()}`);
    query = `SELECT DISTINCT w.id,w.name,w.client_id AS "clientId" FROM legalflow.workspaces w JOIN legalflow.cases c ON c.workspace_id=w.id WHERE w.kind='community' AND NOT w.archived AND ${where.join(" AND ")}`;
  } else if (v.kind === "dates") {
    if (v.q) where.push(`c.data->>'serviceDate' ILIKE ${like()}`);
    where.push("NULLIF(c.data->>'serviceDate','') IS NOT NULL");
    query = `SELECT c.data->>'serviceDate' AS id,c.data->>'serviceDate' AS name,count(*)::int AS count FROM legalflow.cases c WHERE ${where.join(" AND ")} GROUP BY c.data->>'serviceDate'`;
  } else {
    if (v.q)
      where.push(
        `concat_ws(' ',c.number,c.data->>'refId',c.data->>'ref',c.data->>'residentName',c.data->>'residentAddress',c.data->>'unit') ILIKE ${like()}`,
      );
    query = `SELECT c.id,c.number,c.client_id AS "clientId",coalesce(c.workspace_id,'') AS "workspaceId",c.data->>'residentName' AS "residentName",c.data->>'residentAddress' AS "residentAddress",c.data->>'unit' AS unit,c.data->>'refId' AS "refId",c.data->>'status' AS status,c.data->>'propertyType' AS "propertyType",c.data->>'serviceDate' AS "serviceDate",c.data->>'type' AS type, ARRAY(SELECT DISTINCT i.data->>'status' FROM legalflow.invoices i WHERE ${invoiceLink}) AS "invoiceStatuses" FROM legalflow.cases c WHERE ${where.join(" AND ")}`;
  }
  const count = (
    await pool.query(
      `SELECT count(*)::int AS total FROM (${query}) result`,
      args,
    )
  ).rows[0].total;
  params = [...args, v.limit, (v.page - 1) * v.limit];
  const order =
    v.kind === "cases"
      ? "number,id"
      : v.kind === "dates"
        ? "id DESC"
        : "name,id";
  const rows = (
    await pool.query(
      `SELECT * FROM (${query}) result ORDER BY ${order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      params,
    )
  ).rows;
  res.json({ rows, total: count, page: v.page, limit: v.limit });
}
