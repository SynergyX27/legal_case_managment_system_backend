import { fileURLToPath } from "node:url";
import { image } from "./single-case-report.service.js";
import PDFDocument from "pdfkit";
import { pool } from "../config/database.js";
import { accessibleCase } from "../models/case.model.js";
import { can } from "./access.service.js";
import { invoiceCaseIds, invoiceTotals } from "./invoice-math.service.js";
import { assert } from "../utils/errors.js";
import { profile } from "../controllers/company.controller.js";
import { env } from "../config/env.js";
const dollars = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
export async function invoiceForUser(user, id, db = pool) {
  const row = (
    await db.query(
      "SELECT * FROM legalflow.invoices WHERE id=$1 AND deleted_at IS NULL",
      [id],
    )
  ).rows[0];
  assert(row, 404, "Invoice not found");
  assert(
    user.role === "customer"
      ? row.client_id === user.client_id && row.data.status !== "Draft"
      : [
          "invoices.view",
          "invoices.create",
          "invoices.edit",
          "invoices.delete",
        ].some((k) => can(user, k)),
    404,
    "Invoice not found",
  );
  const cases = [];
  for (const id of invoiceCaseIds({ ...row.data, caseId: row.case_id }))
    cases.push(await accessibleCase(user, id, db));
  const customer =
    (
      await db.query("SELECT data FROM legalflow.clients WHERE id=$1", [
        row.client_id,
      ])
    ).rows[0]?.data || {};
  return {
    invoice: { ...row.data, id: row.id, number: row.number },
    cases,
    customer,
  };
}
export function invoiceFilename(i) {
  const c = i.caseSnapshots?.find((c) => c.id === i.caseId) || {};
  const date = c.serviceDate || i.date;
  return (
    [
      `X${date.slice(2, 4)}`,
      i.number,
      c.community || "PROPERTY",
      dollars(invoiceTotals(i).total).replace("$", ""),
      date.slice(5),
    ]
      .join(" - ")
      .replace(/[^a-zA-Z0-9., _-]/g, "_")
      .slice(0, 210) + ".pdf"
  );
}
export async function renderInvoicePdf(records, company) {
  const logo = company.logoDocumentId
    ? await image(company.logoDocumentId, null).catch(() => null)
    : null;
  const doc = new PDFDocument({
    size: "A4",
    margin: 42,
    bufferPages: true,
    autoFirstPage: false,
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
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  for (const { invoice: i, cases, customer } of records) {
    doc.addPage();
    const t = invoiceTotals(i),
      template =
        i.template || (cases[0]?.data.propertyType === "APT" ? "T2A" : "T1");
    const text = (v, x, y, w = 510, size = 10) =>
      doc
        .font("Regular")
        .fontSize(size)
        .fillColor("#243750")
        .text(String(v ?? ""), x, y, { width: w });
    doc.rect(0, 0, 596, 112).fill("#17345b");
    if (logo) doc.image(logo, 42, 23, { fit: [58, 58] });
    doc.font("Bold");
    let companyFont = 22;
    const companyWidth = logo ? 210 : 290;
    while (
      companyFont > 9 &&
      doc
        .fontSize(companyFont)
        .heightOfString(company.companyName || "LegalFlow", {
          width: companyWidth,
        }) > 65
    )
      companyFont--;
    doc
      .fontSize(companyFont)
      .fillColor("white")
      .text(company.companyName || "LegalFlow", logo ? 112 : 42, 30, {
        width: companyWidth,
      });
    doc
      .fontSize(11)
      .text(`INVOICE  /  ${template}`, 370, 32, { width: 180, align: "right" });
    doc
      .font("Regular")
      .fontSize(9)
      .text(i.number, 300, 58, { width: 250, align: "right" });
    doc.text(i.status, 370, 78, { width: 180, align: "right" });
    text(
      [company.address, company.email, company.phone]
        .filter(Boolean)
        .join(" | "),
      42,
      125,
      510,
      9,
    );
    text("BILL TO", 42, 163, 250, 9);
    text(customer.company || customer.name, 42, 181, 245, 12);
    text(
      [customer.name, customer.address, customer.email]
        .filter(Boolean)
        .join("\n"),
      42,
      202,
      245,
      9,
    );
    text(
      `Issued: ${i.date}\nDue: ${i.dueDate}\nCurrency: USD`,
      330,
      181,
      220,
      10,
    );
    let y = Math.max(267, doc.y + 24);
    const header = () => {
      doc.rect(42, y, 510, 24).fill("#e7edf6");
      text("CASE / SERVICE DETAILS", 50, y + 8, 280, 9);
      text("DATA", 340, y + 8, 70, 9);
      text("AMOUNT", 448, y + 8, 95, 9);
      y += 32;
    };
    header();
    for (const l of i.lines) {
      const id = l.caseId || i.caseId;
      const live = cases.find((c) => c.id === id);
      const c = i.caseSnapshots?.find((c) => c.id === id) || {
        number: live?.number,
        ...live?.data,
        tenant: live?.data.residentName,
        address: live?.data.residentAddress,
      };
      const detail = [
        l.description,
        `DATE: ${c.serviceDate || "-"}`,
        `CAS #: ${c.refId || "-"} | Case: ${c.number || "-"}`,
        `TENANT: ${c.tenant || "-"}`,
        `UNIT: ${c.unit || "-"} | STATUS: ${l.serviceOutcome || "Not recorded"}`,
        c.address || "",
      ].join("\n");
      const h = Math.max(
        96,
        doc.fontSize(9).heightOfString(detail, { width: 275 }) + 20,
      );
      if (y + h > 700) {
        doc.addPage();
        y = 45;
        header();
      }
      text(detail, 50, y, 275, 9);
      const url = new URL(`/cases/${encodeURIComponent(id)}`, env.APP_ORIGIN)
        .href;
      doc
        .fontSize(10)
        .fillColor("#295bb3")
        .text("VIS: case visuals", 340, y, {
          width: 95,
          link: url,
          underline: true,
        });
      text(
        `${l.qty} x ${dollars(Math.round(l.price * 100))}\n${dollars(Math.round(l.qty * l.price * 100))}`,
        442,
        y,
        105,
        10,
      );
      y += h;
      doc
        .moveTo(42, y - 8)
        .lineTo(552, y - 8)
        .strokeColor("#dce4ef")
        .stroke();
    }
    if (y + 150 > 755) {
      doc.addPage();
      y = 45;
    }
    for (const [label, value] of [
      ["Base price", t.base],
      ["Discount", -t.discount],
      ["Amount", t.net],
      [`Tax (${i.taxRate}%)`, t.tax],
      ["Total due", t.total],
    ]) {
      text(label, 330, y, 125, 11);
      text(dollars(value), 450, y, 100, 11);
      y += 24;
    }
    text(
      "VIS links require LegalFlow sign-in and case access. Service outcome is separate from invoice payment status.",
      42,
      Math.min(y + 15, 785),
      510,
      8,
    );
  }
  const pages = doc.bufferedPageRange();
  for (let n = 0; n < pages.count; n++) {
    doc.switchToPage(n);
    doc.page.margins.bottom = 16;
    doc
      .fontSize(8)
      .fillColor("#64748b")
      .text(`LegalFlow | ${n + 1} / ${pages.count}`, 42, 815, {
        width: 510,
        align: "right",
        lineBreak: false,
      });
  }
  doc.end();
  return done;
}
export async function invoicePdf(user, ids) {
  const records = [];
  for (const id of ids) records.push(await invoiceForUser(user, id));
  return {
    buffer: await renderInvoicePdf(records, await profile()),
    filename:
      records.length === 1
        ? invoiceFilename(records[0].invoice)
        : "LegalFlow-combined-invoices.pdf",
    records,
  };
}
