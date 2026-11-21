import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { caseInput } from "../validators/schemas.js";
import { assert } from "../utils/errors.js";

const normalize = (v) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const aliases = {
  ref: ["ref", "reference"],
  number: ["casenumber", "caseno", "number"],
  title: ["title", "casetitle"],
  clientId: ["customer", "customerid", "client", "clientid"],
  staffId: ["assignedstaff", "staff", "staffid"],
  managerId: ["assignedmanager", "manager", "managerid"],
  residentName: ["tenant", "residentname"],
  residentAddress: ["address", "residentaddress"],
  residentPhone: ["phone", "residentphone"],
  plaintiff: ["plaintiff"],
  community: ["community", "apartmentcommunity", "apartment"],
  neighborhood: ["neighborhood", "neighbourhood"],
  county: ["county"],
  city: ["city"],
  state: ["state"],
  zip: ["zip", "zipcode"],
  status: ["status"],
  type: ["type", "casetype"],
  priority: ["priority"],
  moneyOwed: [
    "moneyowed",
    "amountowed",
    "casebalance",
    "balanceowed",
    "originalbalance",
  ],
  serviceDate: ["setoutdate", "servicedate"],
  serviceTime: ["setouttime", "servicetime"],
  visLO: ["vislo"],
  visTO: ["visto"],
  locs: ["locs"],
  lbx: ["lbx"],
  description: ["description"],
  notes: ["notes"],
};
function value(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v !== "object" || v instanceof Date) return v;
  if ("formula" in v || "sharedFormula" in v)
    throw new Error("Replace formulas with their values before importing");
  if ("richText" in v) return v.richText.map((part) => part.text).join("");
  if ("text" in v) return v.text;
  throw new Error("Unsupported cell value");
}
function resolve(input, rows, fields, label) {
  const query = String(input ?? "")
    .trim()
    .toLowerCase();
  const matches = rows.filter((r) =>
    fields.some((f) => String(r[f] ?? "").toLowerCase() === query),
  );
  assert(
    query && matches.length === 1,
    422,
    `Select a unique ${label} using its ID, username or name`,
  );
  return matches[0];
}
export async function parseCaseFile(file) {
  assert(file && file.buffer.length, 422, "Choose a CSV or XLSX file");
  const workbook = new ExcelJS.Workbook();
  let sheet;
  if (/\.csv$/i.test(file.originalname)) {
    sheet = await workbook.csv.read(Readable.from(file.buffer), {
      parserOptions: { trim: true },
      map: (v) => v, // Preserve leading zeroes in ZIP codes and case numbers.
    });
  } else {
    assert(
      /\.xlsx$/i.test(file.originalname),
      422,
      "Use CSV or Excel XLSX format",
    );
    await workbook.xlsx.load(file.buffer);
    sheet = workbook.worksheets[0];
  }
  assert(
    sheet && sheet.rowCount >= 2 && sheet.rowCount <= 1001,
    422,
    "Use a header row and 1–1,000 case rows",
  );
  assert(sheet.columnCount <= 100, 422, "The file has too many columns");
  const headers = new Map();
  let hasOriginalBalance = false;
  sheet.getRow(1).eachCell((cell) => {
    if (normalize(value(cell)) === "originalbalance") hasOriginalBalance = true;
  });
  sheet.getRow(1).eachCell((cell, index) => {
    const header = normalize(value(cell));
    const key = Object.keys(aliases).find((k) => aliases[k].includes(header));
    if (
      key === "moneyOwed" &&
      hasOriginalBalance &&
      header !== "originalbalance"
    )
      return;
    if (key) {
      assert(!headers.has(key), 422, `Duplicate column for ${key}`);
      headers.set(key, index);
    }
  });
  assert(
    headers.has("number") && headers.has("residentName"),
    422,
    "Include Case Number and Tenant column headers",
  );
  const rows = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const raw = { rowNumber: index };
    for (const [key, column] of headers) raw[key] = value(row.getCell(column));
    if (Object.keys(raw).some((key) => key !== "rowNumber" && raw[key] !== ""))
      rows.push(raw);
  });
  return rows;
}
export function prepareImport(
  rawRows,
  defaults,
  user,
  clients,
  users,
  existingNumbers,
  customFields,
) {
  const seen = new Set(existingNumbers.map((n) => n.toLowerCase()));
  return rawRows.map((raw) => {
    try {
      const customer = resolve(
        raw.clientId || defaults.clientId,
        clients,
        ["id", "name", "company", "email", "username"],
        "customer",
      );
      const staff = resolve(
        user.role === "staff" ? user.id : raw.staffId || defaults.staffId,
        users.filter((u) => u.role === "staff" && u.status === "Active"),
        ["id", "name", "username", "email"],
        "staff member",
      );
      assert(
        user.role !== "manager" || staff.manager_id === user.id,
        403,
        "Choose staff assigned to your team",
      );
      const manager = users.find(
        (u) =>
          u.id === staff.manager_id &&
          u.role === "manager" &&
          u.status === "Active",
      );
      assert(
        manager,
        422,
        "Assign an active manager to this staff member in People & access",
      );
      if (raw.managerId)
        assert(
          resolve(
            raw.managerId,
            users,
            ["id", "name", "username", "email"],
            "manager",
          ).id === manager.id,
          422,
          "The manager must match the staff member’s team",
        );
      const record = Object.fromEntries(
        Object.entries(raw)
          .filter(([k]) => k !== "rowNumber")
          .map(([k, v]) => [
            k,
            v instanceof Date
              ? k === "serviceTime"
                ? v.toISOString().slice(11, 16)
                : v.toISOString().slice(0, 10)
              : k === "serviceTime" && typeof v === "number" && v >= 0 && v < 1
                ? new Date(Math.round(v * 86400000)).toISOString().slice(11, 16)
                : String(v).trim(),
          ]),
      );
      const amountText = String(raw.moneyOwed ?? "0").replace(/[$,\s]/g, "");
      assert(
        /^\d+(\.\d{1,2})?$/.test(amountText),
        422,
        "Money owed must have at most two decimal places",
      );
      const parsed = caseInput.parse({
        ...record,
        id: "case" + randomUUID(),
        title:
          record.title ||
          `${customer.company || customer.name} v. ${record.residentName}`,
        clientId: customer.id,
        staffId: staff.id,
        managerId: manager.id,
        status: record.status || defaults.status || "Pending",
        type: record.type || "Eviction Notice",
        priority: record.priority || "Medium",
        moneyOwed: Number(amountText),
        custom: defaults.custom || {},
      });
      assert(
        !seen.has(parsed.number.toLowerCase()),
        409,
        "Case number already exists or is duplicated in this file",
      );
      const missing = customFields.find(
        (f) =>
          f.required &&
          (parsed.custom[f.id] === undefined || parsed.custom[f.id] === ""),
      );
      assert(!missing, 422, `${missing?.label} is required`);
      seen.add(parsed.number.toLowerCase());
      return { rowNumber: raw.rowNumber, case: parsed };
    } catch (error) {
      return {
        rowNumber: raw.rowNumber,
        error:
          error.issues
            ?.map((x) => `${x.path.join(".")}: ${x.message}`)
            .join("; ") || error.message,
      };
    }
  });
}
