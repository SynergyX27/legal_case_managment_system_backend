import { pool } from "../config/database.js";
import { publicUser } from "./user.model.js";
import { caseScope, canMessage } from "../services/access.service.js";
export async function workspace(u) {
  const scope = caseScope(u);
  const rawCases = (
    await pool.query(
      `SELECT c.* FROM legalflow.cases c WHERE ${scope.sql} ORDER BY created_at DESC`,
      scope.values,
    )
  ).rows;
  const ids = rawCases.map((c) => c.id);
  const users = (
    await pool.query("SELECT * FROM legalflow.users ORDER BY name")
  ).rows;
  const related = users.filter(
    (p) => p.id === u.id || u.role === "owner" || canMessage(u, p, rawCases),
  );
  const userViews = related.map((p) => {
    const v = publicUser(p);
    return u.role === "owner" || u.id === p.id
      ? v
      : {
          id: v.id,
          name: v.name,
          role: v.role,
          status: v.status,
          clientId: v.clientId,
          accountId: "company",
          title: v.title,
          email: "",
          phone: "",
          lastLogin: "",
          online: false,
        };
  });
  const [
    clients,
    invoices,
    docs,
    activities,
    comments,
    events,
    notifications,
    prefs,
    fields,
    memberRows,
  ] = await Promise.all([
    pool.query(
      u.role === "owner"
        ? "SELECT data FROM legalflow.clients ORDER BY created_at DESC"
        : "SELECT data FROM legalflow.clients WHERE id=ANY($1::text[])",
      [
        ...(u.role === "owner"
          ? []
          : [
              [
                ...new Set(
                  [...rawCases.map((c) => c.client_id), u.client_id].filter(
                    Boolean,
                  ),
                ),
              ],
            ]),
      ],
    ),
    ["owner", "manager", "customer"].includes(u.role)
      ? pool.query(
          "SELECT data||jsonb_build_object('id',id,'number',number,'caseId',case_id,'clientId',client_id,'updatedAt',updated_at) AS data FROM legalflow.invoices WHERE case_id=ANY($1::text[]) AND ($2::boolean OR data->>'status'<>'Draft') ORDER BY created_at DESC",
          [ids, u.role !== "customer"],
        )
      : Promise.resolve({ rows: [] }),
    pool.query(
      "SELECT d.*,u.name AS uploader FROM legalflow.documents d JOIN legalflow.users u ON u.id=d.uploaded_by WHERE d.state='ready' AND (d.case_id=ANY($1::text[]) OR ($2::boolean AND d.case_id IS NULL))",
      [ids, u.role === "owner"],
    ),
    u.role !== "customer"
      ? pool.query(
          "SELECT a.*,u.name AS actor FROM legalflow.activities a LEFT JOIN legalflow.users u ON u.id=a.user_id WHERE case_id=ANY($1::text[]) ORDER BY at DESC",
          [ids],
        )
      : Promise.resolve({ rows: [] }),
    u.role !== "customer"
      ? pool.query(
          "SELECT * FROM legalflow.comments WHERE case_id=ANY($1::text[]) ORDER BY at",
          [ids],
        )
      : Promise.resolve({ rows: [] }),
    u.role === "customer"
      ? Promise.resolve({ rows: [] })
      : pool.query(
          u.role === "owner"
            ? "SELECT data FROM legalflow.events"
            : "SELECT data FROM legalflow.events WHERE staff_id=$1 OR $2='manager'",
          u.role === "owner" ? [] : [u.id, u.role],
        ),
    pool.query(
      "SELECT * FROM legalflow.notifications WHERE user_id=$1 ORDER BY at DESC LIMIT 500",
      [u.id],
    ),
    pool.query("SELECT data FROM legalflow.preferences WHERE user_id=$1", [
      u.id,
    ]),
    pool.query("SELECT data FROM legalflow.custom_fields ORDER BY id"),
    pool.query(
      "SELECT c.id,m.user_id,m.last_read_id FROM legalflow.conversations c JOIN legalflow.conversation_members m ON m.conversation_id=c.id WHERE c.id IN(SELECT conversation_id FROM legalflow.conversation_members WHERE user_id=$1)",
      [u.id],
    ),
  ]);
  const conversations = [];
  const chatRead = {};
  for (const cid of [...new Set(memberRows.rows.map((m) => m.id))]) {
    const members = memberRows.rows.filter((m) => m.id === cid);
    const other = users.find(
      (p) => p.id === members.find((m) => m.user_id !== u.id)?.user_id,
    );
    if (!canMessage(u, other, rawCases)) continue;
    const messages = (
      await pool.query(
        "SELECT * FROM legalflow.messages WHERE conversation_id=$1 ORDER BY at,id",
        [cid],
      )
    ).rows;
    conversations.push({
      id: cid,
      name: "",
      kind: "dm",
      members: members.map((m) => m.user_id),
      messages: messages.map((m) => ({
        id: m.id,
        by: m.user_id,
        text: m.text,
        at: m.at.toISOString(),
      })),
    });
    const mine = members.find((m) => m.user_id === u.id);
    if (mine?.last_read_id) chatRead[`${u.id}:${cid}`] = mine.last_read_id;
  }
  const attachments = docs.rows.map(documentView);
  return {
    accounts: [{ id: "company", name: "LegalFlow" }],
    users: userViews,
    clients: clients.rows.map((c) => c.data),
    cases: rawCases.map((c) => ({
      ...c.data,
      id: c.id,
      number: c.number,
      clientId: c.client_id,
      staffId: c.staff_id || "",
      managerId: c.manager_id || "",
      accountId: "company",
      fee: 0,
      invoiceStatus: "Not Invoiced",
      paymentStatus: "Unpaid",
      createdAt: c.created_at.toISOString(),
      updatedAt: c.updated_at.toISOString(),
      ...(u.role === "customer" ? { notes: "", instructions: "" } : {}),
      attachments: attachments
        .filter((d) => d.caseId === c.id)
        .map(({ caseId, ...d }) => d),
      comments: comments.rows
        .filter((m) => m.case_id === c.id)
        .map((m) => ({
          id: m.id,
          by: m.user_id,
          text: m.text,
          at: m.at.toISOString(),
        })),
    })),
    invoices: invoices.rows.map((i) => i.data),
    events: events.rows.map((e) => e.data),
    activities: activities.rows.map((a) => ({
      id: a.id,
      caseId: a.case_id,
      by: a.actor || "Team",
      text: a.text,
      kind: a.kind,
      at: a.at.toISOString(),
    })),
    companyDocuments: attachments
      .filter((d) => !d.caseId)
      .map(({ caseId, ...d }) => d),
    notifications: notifications.rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      link: n.link,
      read: n.read,
      at: n.at.toISOString(),
    })),
    conversations,
    chatRead,
    customFields: fields.rows.map((f) => f.data),
    savedViews: prefs.rows[0]?.data.savedViews || [],
    tablePrefs: prefs.rows[0]?.data.tablePrefs || null,
  };
}
export function documentView(d) {
  return {
    id: d.id,
    caseId: d.case_id,
    name: d.name,
    type: d.kind,
    size:
      d.bytes < 1048576
        ? `${Math.max(1, Math.round(d.bytes / 1024))} KB`
        : `${(d.bytes / 1048576).toFixed(1)} MB`,
    uploadedAt: d.created_at.toISOString(),
    uploadedBy: d.uploader || "",
    url: `/api/documents/${d.id}/content`,
  };
}
