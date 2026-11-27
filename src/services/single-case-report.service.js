import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { pool } from "../config/database.js";
import { accessibleCase } from "../models/case.model.js";
import { withCaseBalances, caseAmounts } from "./case-balance.service.js";
import { profile } from "../controllers/company.controller.js";
import { downloadFile } from "./dropbox.service.js";
import { assert } from "../utils/errors.js";
const money = (v) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(v) || 0,
  );
export async function image(id, caseId, user) {
  if (!id) return null;
  const d = (
    await pool.query(
      "SELECT * FROM legalflow.documents WHERE id=$1 AND state='ready'",
      [id],
    )
  ).rows[0];
  assert(
    d &&
      (caseId ? d.case_id === caseId : !d.case_id) &&
      (user?.role !== "customer" || d.approval === "approved") &&
      ["image/png", "image/jpeg"].includes(d.mime) &&
      Number(d.bytes) <= 5 * 1024 * 1024,
    422,
    "Choose a PNG or JPEG report photo up to 5 MB",
  );
  const body = await downloadFile(d.dropbox_path),
    chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) {
      await body.cancel?.().catch(() => {});
      throw new Error("Report image too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function singleCasePdf(user, id, photoId) {
  const row = await accessibleCase(user, id);
  const c = (await withCaseBalances(pool, [row]))[0].data;
  const client =
    (
      await pool.query("SELECT data FROM legalflow.clients WHERE id=$1", [
        row.client_id,
      ])
    ).rows[0]?.data || {};
  const names = (
    await pool.query(
      "SELECT id,name FROM legalflow.users WHERE id=ANY($1::text[])",
      [[row.staff_id, row.manager_id, ...(row.data.teamMemberIds || [])].filter(Boolean)],
    )
  ).rows;
  const customFields = (
    await pool.query("SELECT id,data FROM legalflow.custom_fields")
  ).rows;
  const p = await profile(),
    amounts = caseAmounts(c);
  const logo = p.logoDocumentId
    ? await image(p.logoDocumentId, null).catch(() => null)
    : null;
  const photo = photoId ? await image(photoId, id, user) : null;
  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    bufferPages: true,
    info: { Title: `Case ${row.number}`, Author: p.companyName },
  });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont(
    "Regular",
    fileURLToPath(
      new URL("../../assets/fonts/DejaVuSans.ttf", import.meta.url),
    ),
  );
  doc.registerFont(
    "Bold",
    fileURLToPath(
      new URL("../../assets/fonts/DejaVuSans-Bold.ttf", import.meta.url),
    ),
  );
  doc.font("Regular");
  if (logo) doc.image(logo, 48, 45, { fit: [110, 65] });
  doc
    .font("Bold")
    .fontSize(22)
    .fillColor("#244e88")
    .text(p.companyName, 175, 48, { width: 370, align: "right" });
  doc
    .font("Regular")
    .fontSize(9)
    .fillColor("#526179")
    .text(
      [p.address, p.phone, p.email, p.website].filter(Boolean).join("\n"),
      175,
      82,
      { width: 370, align: "right" },
    );
  doc
    .font("Bold")
    .fontSize(28)
    .fillColor("#142a46")
    .text(p.coverTitle || "Property case report", 48, 185, {
      width: 499,
      align: "center",
    });
  doc
    .fontSize(16)
    .text(c.community || c.residentAddress || row.number, 48, 265, {
      width: 499,
      align: "center",
    });
  if (photo)
    doc.image(photo, 80, 320, {
      fit: [435, 245],
      align: "center",
      valign: "center",
    });
  else {
    doc.roundedRect(80, 320, 435, 155, 10).fill("#edf3fb");
    doc
      .font("Regular")
      .fontSize(13)
      .fillColor("#244e88")
      .text(c.residentAddress || row.number, 104, 375, {
        width: 387,
        align: "center",
      });
  }
  const variables = {
    community: c.community || c.residentAddress || "",
    address: c.residentAddress || "",
    caseNumber: row.number,
    clientName: client.name || client.company || "",
    refId: c.refId || "",
  };
  const body = p.coverText.replace(
    /\{(community|address|caseNumber|clientName|refId)\}/g,
    (_, k) => variables[k],
  );
  doc.font("Regular").fontSize(11).fillColor("#25374d").text(body, 60, 600, {
    width: 475,

    align: "center",
  });
  doc.addPage();
  const groups = [
    [
      "Case",
      [
        ["Case number", row.number],
        ["REF CL#", c.ref],
        ["REF ID#", c.refId],
        ["Customer", client.name || client.company],
        ["Attorney", c.attorney],
        ["Team Members", names.map(u=>u.name).join(", ")],
        ["Responsible staff", names.find((x) => x.id === row.staff_id)?.name],
        [
          "Responsible manager",
          names.find((x) => x.id === row.manager_id)?.name,
        ],
        ["Priority", c.priority],
        ["Description", c.description],
        ["Plaintiff", c.plaintiff],
        ["Tenant", c.residentName],
        ["Case type", c.type],
        ["Status", c.status],
      ],
    ],
    [
      "Property",
      [
        ["Property type", c.propertyType],
        ["Community", c.community],
        ["Neighborhood", c.neighborhood],
        ["Address", c.residentAddress],
        ["Suite / Unit #", c.unit],
        ["County", c.county],
        ["City", c.city],
        ["State", c.state],
        ["Zip", c.zip],
        ["SF", c.squareFeet],
      ],
    ],
    [
      "Financials",
      [
        ["Original amount", money(amounts.original)],
        ["Paid amount", money(amounts.paid)],
        ["Owed amount", money(amounts.due)],
        ["Monthly rent", c.monthlyRent == null ? "" : money(c.monthlyRent)],
        ["Last rental payment date", c.lastPaymentDate],
      ],
    ],
    [
      "Data / service",
      [
        ["Setout date", c.serviceDate],
        ["Setout time", c.serviceTime],
        ["VIS - LO", c.visLO],
        ["VIS - TO", c.visTO],
        ["VIS - RI", c.visRI],
        ["LOCS", c.locs],
        ["LBX", c.lbx],
        ["Service location", c.serviceLocation],
        ["Service instructions", user.role === "customer" ? "" : c.instructions],
        ...customFields.map((f) => [f.data.label, c.custom?.[f.id]]),
      ],
    ],
  ];
  for (const [title, fields] of groups) {
    if (doc.y > 650) doc.addPage();
    doc.font("Bold").fontSize(15).fillColor("#244e88").text(title);
    doc.moveDown(0.4);
    for (const [label, value] of fields) {
      if (doc.y > 735) doc.addPage();
      doc
        .font("Regular")
        .fontSize(10)
        .fillColor("#25374d")
        .text(
          `${label}: ${value === undefined || value === null || value === "" ? "—" : value}`,
        );
      doc.moveDown(0.25);
    }
    doc.moveDown();
  }
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc
      .font("Regular")
      .fontSize(8)
      .fillColor("#607086")
      .text(`${row.number}  ·  ${i + 1} / ${pages.count}`, 48, 790, {
        lineBreak: false,
      });
  }
  doc.end();
  return {
    buffer: await done,
    filename: `case-${row.number.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`,
  };
}
