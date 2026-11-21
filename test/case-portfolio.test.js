import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  parseCaseFile,
  prepareImport,
} from "../src/services/case-import.service.js";
import {
  caseMoney,
  selectReportCases,
  caseReportHtml,
} from "../src/services/case-report.service.js";

test("CSV and Excel preserve identifiers, validate rows and derive team assignments", async () => {
  const csv = Buffer.from(
    'Case Number,Tenant,Apartment Community,Zip,Money Owed,Status\r\n001,"Tenant, One",Southland Hills,00125,"1,200.50",Rescheduled\r\n002,Tenant Two,Westbrook,00201,100000,Completed',
  );
  const raw = await parseCaseFile({ originalname: "cases.csv", buffer: csv });
  assert.equal(raw[0].number, "001");
  assert.equal(raw[0].zip, "00125");
  const clients = [{ id: "customer", name: "Client", company: "Client" }];
  const users = [
    {
      id: "staff",
      name: "Staff",
      role: "staff",
      status: "Active",
      manager_id: "manager",
    },
    { id: "manager", name: "Manager", role: "manager", status: "Active" },
  ];
  const defaults = { clientId: "customer", staffId: "staff" };
  const ready = prepareImport(
    raw,
    defaults,
    { role: "owner" },
    clients,
    users,
    [],
    [],
  );
  assert(
    ready.every((r) => r.case),
    JSON.stringify(ready),
  );
  assert.equal(ready[0].case.moneyOwed, 1200.5);
  assert.equal(ready[0].case.managerId, "manager");
  assert(
    prepareImport(
      raw,
      defaults,
      { role: "manager", id: "another-manager" },
      clients,
      users,
      [],
      [],
    )[0].error,
  );
  assert(
    prepareImport(
      raw,
      defaults,
      { role: "owner" },
      clients,
      users,
      ["001"],
      [],
    )[0].error,
  );
  assert(
    prepareImport(
      [{ ...raw[0], moneyOwed: "100000.01" }],
      defaults,
      { role: "owner" },
      clients,
      users,
      [],
      [],
    )[0].error,
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Cases");
  sheet.addRow([
    "Case Number",
    "Tenant",
    "Setout Date",
    "Setout Time",
    "Zip",
    "Money Owed",
  ]);
  sheet.addRow([
    "0007",
    "Tenant",
    new Date("2026-11-21T00:00:00Z"),
    0.5,
    "00101",
    350.25,
  ]);
  const excel = await parseCaseFile({
    originalname: "cases.xlsx",
    buffer: await workbook.xlsx.writeBuffer(),
  });
  const result = prepareImport(
    excel,
    defaults,
    { role: "owner" },
    clients,
    users,
    [],
    [],
  );
  assert.equal(result[0].case.serviceDate, "2026-11-21");
  assert.equal(result[0].case.serviceTime, "12:00");
  assert.equal(result[0].case.zip, "00101");
});
test("case-balance reports isolate exact communities and use completion status for clearing", () => {
  const rows = [
    {
      number: "1",
      community: "Southland Hills",
      status: "Active",
      moneyOwed: 0.1,
      clientId: "one",
    },
    {
      number: "2",
      community: "Southland Hills",
      status: "Completed",
      moneyOwed: 0.2,
      clientId: "one",
    },
    {
      number: "3",
      community: "Southland Hills East",
      status: "Completed",
      moneyOwed: 500,
      clientId: "two",
    },
  ];
  const matching = selectReportCases(rows, { community: "southland hills" });
  assert.equal(matching.length, 2);
  assert.deepEqual(caseMoney(matching), { owed: 0.3, cleared: 0.2, due: 0.1 });
  assert.deepEqual(caseMoney([{ status: "Active" }]), {
    owed: 0,
    cleared: 0,
    due: 0,
  });
  const html = caseReportHtml(
    [{ ...rows[0], residentName: "<script>alert(1)</script>" }],
    {},
    ["All cases", "Active"],
  );
  assert(html.includes("All cases: 1"));
  assert(!html.includes("<script>"));
});
