import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
} from "../src/services/password.service.js";
import { canMessage, visible } from "../src/services/access.service.js";
import {
  caseInput,
  invoiceInput,
  userInput,
} from "../src/validators/schemas.js";
test("password hashes use random salts and verify without plaintext storage", async () => {
  const a = await hashPassword("A-long-test-password-17");
  const b = await hashPassword("A-long-test-password-17");
  assert.notEqual(a, b);
  assert(!a.includes("A-long"));
  assert(await verifyPassword("A-long-test-password-17", a));
  assert(!(await verifyPassword("wrong-password", a)));
});
test("customers can only access their own cases and assigned contacts", () => {
  const c = {
    client_id: "client-a",
    staff_id: "staff-a",
    manager_id: "manager-a",
  };
  const customer = {
      id: "customer-a",
      role: "customer",
      client_id: "client-a",
      status: "Active",
    },
    other = {
      id: "customer-b",
      role: "customer",
      client_id: "client-b",
      status: "Active",
    },
    staff = { id: "staff-a", role: "staff", status: "Active" },
    stranger = { id: "staff-b", role: "staff", status: "Active" };
  assert(visible(customer, c));
  assert(!visible(other, c));
  assert(canMessage(customer, staff, [c]));
  assert(!canMessage(customer, stranger, [c]));
  assert(!canMessage(customer, other, [c]));
  assert(!canMessage(customer, { ...staff, status: "Inactive" }, [c]));
});
test("server rejects invalid invoice money and dates", () => {
  const base = {
    id: "i1",
    caseId: "c1",
    clientId: "p1",
    date: "2026-11-01",
    dueDate: "2026-11-02",
    lines: [{ description: "Service", qty: 1, price: 100 }],
    taxRate: 0,
    status: "Draft",
  };
  assert(invoiceInput.safeParse(base).success);
  for (const patch of [
    { taxRate: 101 },
    { dueDate: "2026-10-01" },
    { date: "2026-02-31" },
    { lines: [{ description: "Service", qty: 1, price: -1 }] },
    { lines: [] },
  ])
    assert(!invoiceInput.safeParse({ ...base, ...patch }).success);
});
test("case parsing strips financial and document payloads", () => {
  const c = caseInput.parse({
    id: "c1",
    number: "REF-1",
    title: "Test",
    clientId: "p1",
    residentName: "Tenant",
    type: "Notice",
    status: "Pending",
    priority: "Medium",
    fee: 999,
    attachments: [{ url: "https://untrusted" }],
  });
  assert.equal(c.fee, undefined);
  assert.equal(c.attachments, undefined);
});
test("registration requires a strong minimum and safe username", () => {
  assert(
    !userInput.safeParse({
      name: "User",
      email: "a@example.com",
      username: "a@example.com",
      password: "123",
    }).success,
  );
});
