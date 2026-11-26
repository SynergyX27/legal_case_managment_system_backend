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
const invoiceDate = (v) =>
  v
    ? new Date(v.length === 10 ? v + "T12:00:00Z" : v).toLocaleDateString(
        "en-US",
        { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC" },
      )
    : "—";
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
  const ink = "#172b46",
    muted = "#748399",
    line = "#e4eaf2",
    blue = "#315fba";
  const text = (v, x, y, w = 510, size = 9, options = {}) =>
    doc
      .font("Regular")
      .fontSize(size)
      .fillColor(ink)
      .text(String(v ?? ""), x, y, { width: w, ...options });
  const label = (v, x, y, w = 210) =>
    doc
      .font("Bold")
      .fontSize(8)
      .fillColor(muted)
      .text(v, x, y, { width: w, characterSpacing: 0.5 });
  for (const { invoice: i, cases, customer } of records) {
    doc.addPage();
    const t = invoiceTotals(i),
      paid = i.status === "Paid",
      template =
        i.template || (cases[0]?.data.propertyType === "APT" ? "T2A" : "T1");
    let brandX = 42;
    if (logo) {
      doc.image(logo, 42, 38, { fit: [42, 42] });
      brandX = 96;
    }
    let nameSize = 18;
    doc.font("Bold");
    while (
      nameSize > 9 &&
      doc
        .fontSize(nameSize)
        .heightOfString(company.companyName || "LegalFlow", {
          width: 245 - (brandX - 42),
        }) > 45
    )
      nameSize--;
    doc
      .fontSize(nameSize)
      .fillColor(ink)
      .text(company.companyName || "LegalFlow", brandX, 42, {
        width: 245 - (brandX - 42),
      });
    label("SERVICE INVOICE", brandX, 93);
    doc
      .font("Bold")
      .fontSize(24)
      .fillColor(ink)
      .text("INVOICE", 340, 38, { width: 212, align: "right" });
    text(i.number, 300, 74, 252, 9, { align: "right" });
    doc.roundedRect(458, 99, 94, 23, 6).fill(paid ? "#e5f4ed" : "#fff4d8");
    doc
      .font("Bold")
      .fontSize(8)
      .fillColor(paid ? "#21845a" : "#966d12")
      .text(paid ? "PAID" : i.status.toUpperCase(), 462, 106, {
        width: 86,
        align: "center",
      });
    doc.moveTo(42, 137).lineTo(552, 137).strokeColor(line).stroke();
    label("FROM", 42, 155);
    label("BILL TO", 310, 155);
    const from = [
      company.companyName,
      company.address,
      company.email,
      company.phone,
    ]
      .filter(Boolean)
      .join("\n");
    const to = [
      customer.company || customer.name,
      customer.company && customer.name !== customer.company
        ? customer.name
        : "",
      customer.address,
      customer.email,
      customer.phone,
    ]
      .filter(Boolean)
      .join("\n");
    text(from, 42, 173, 220, 9);
    const fromEnd = doc.y;
    text(to, 310, 173, 242, 9);
    let y = Math.max(fromEnd, doc.y) + 25;
    label("INVOICE DATE", 42, y, 150);
    label("DUE DATE", 215, y, 150);
    label("TEMPLATE / CURRENCY", 390, y, 162);
    text(invoiceDate(i.date), 42, y + 17, 150, 10);
    text(invoiceDate(i.dueDate), 215, y + 17, 150, 10);
    text(`${template} / USD`, 390, y + 17, 162, 10);
    y += 54;
    const header = () => {
      doc.rect(42, y, 510, 27).fill("#f3f6fb");
      label("#", 51, y + 10, 25);
      label("SERVICE DETAILS", 82, y + 10, 262);
      label("QTY", 352, y + 10, 40);
      label("UNIT PRICE", 398, y + 10, 72);
      label("AMOUNT", 484, y + 10, 65);
      y += 37;
    };
    header();
    for (let n = 0; n < i.lines.length; n++) {
      const l = i.lines[n],
        id = l.caseId || i.caseId,
        live = cases.find((c) => c.id === id);
      const c = i.caseSnapshots?.find((c) => c.id === id) || {
        number: live?.number,
        ...live?.data,
        tenant: live?.data.residentName,
        address: live?.data.residentAddress,
      };
      const details = [
        `CAS # ${c.refId || "-"}  /  Case ${c.number || "-"}`,
        c.tenant || "",
        `${c.address || ""}${c.unit ? " / Unit " + c.unit : ""}`,
        `Service: ${invoiceDate(c.serviceDate)}  /  ${l.serviceOutcome || "Outcome not recorded"}`,
      ]
        .filter(Boolean)
        .join("\n");
      const titleH = doc
        .font("Bold")
        .fontSize(9)
        .heightOfString(l.description, { width: 255 });
      const detailH = doc
        .font("Regular")
        .fontSize(8)
        .heightOfString(details, { width: 255 });
      const h = Math.max(72, titleH + detailH + 32);
      if (y + h > 715) {
        doc.addPage();
        label(`${i.number} / CONTINUED`, 42, 38, 510);
        y = 63;
        header();
      }
      text(String(n + 1).padStart(2, "0"), 51, y, 25, 9);
      doc
        .font("Bold")
        .fontSize(9)
        .fillColor(ink)
        .text(l.description, 82, y, { width: 255 });
      doc
        .font("Regular")
        .fontSize(8)
        .fillColor(muted)
        .text(details, 82, y + titleH + 5, { width: 255 });
      doc
        .fontSize(7)
        .fillColor(blue)
        .text(
          "DATA / VIS - view in case portal",
          82,
          y + titleH + detailH + 9,
          {
            width: 255,
            link: new URL(`/cases/${encodeURIComponent(id)}`, env.APP_ORIGIN)
              .href,
            underline: true,
          },
        );
      text(l.qty, 346, y, 42, 9, { align: "center" });
      text(dollars(Math.round(l.price * 100)), 390, y, 78, 9, {
        align: "right",
      });
      text(dollars(Math.round(l.qty * l.price * 100)), 474, y, 78, 9, {
        align: "right",
      });
      y += h;
      doc
        .moveTo(42, y - 7)
        .lineTo(552, y - 7)
        .strokeColor(line)
        .stroke();
    }
    const summaries = [
      ["Base price", t.base],
      ["Discount", -t.discount],
      ["Amount", t.net],
      [`Tax (${i.taxRate}%)`, t.tax],
      ["Invoice total", t.total],
      [paid ? "Amount paid" : "Balance due", paid ? t.total : t.total],
    ];
    if (y + summaries.length * 22 + 8 + (paid ? 22 : 0) + 62 > 790) {
      doc.addPage();
      label(`${i.number} / TOTALS`, 42, 40, 510);
      y = 75;
    }
    y += 8;
    for (let n = 0; n < summaries.length; n++) {
      const [name, value] = summaries[n];
      if (n === summaries.length - 1) {
        doc
          .roundedRect(315, y - 6, 237, 30, 5)
          .fill(paid ? "#eaf6ef" : "#eef3fc");
      }
      text(name, 327, y, 135, 9);
      text(dollars(value), 465, y, 76, 9, { align: "right" });
      y += 22;
    }
    if (paid) {
      text("Balance due", 327, y, 135, 9);
      text(dollars(0), 465, y, 76, 9, { align: "right" });
      y += 22;
    }
    const note = paid
      ? "Thank you. Payment has been received for this invoice."
      : "Thank you for your business. Please use the private invoice link in your email to pay securely online.";
    if (y + 62 > 790) {
      doc.addPage();
      y = 55;
    }
    doc.roundedRect(42, y + 8, 510, 42, 5).fill("#f5f7fa");
    text(note, 55, y + 20, 484, 8);
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
