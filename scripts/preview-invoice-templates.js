// Offline, fictional previews. Does not connect to the database or send mail.
import { writeFile, mkdir } from "node:fs/promises";
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
  DB_SSL_MODE: "disable",
  SESSION_SECRET: "offline-template-preview-secret-0123456789",
  APP_ENCRYPTION_KEY: "a".repeat(64),
  APP_ORIGIN: "https://legal-case-managment-system-front-end.onrender.com",
  DROPBOX_REDIRECT_URI:
    "https://legal-case-managment-system-front-end.onrender.com/api/integrations/dropbox/callback",
});
const { renderInvoicePdf } =
  await import("../src/services/invoice-pdf.service.js");
const company = {
  companyName: "Demo Property Services",
  address: "100 Example Avenue, Atlanta, GA 30303",
  phone: "404-555-0100",
  email: "billing@example.invalid",
};
const records = ["T1", "T2A", "T2B"].map((template, n) => {
  const caseSnapshots = Array.from(
    { length: template === "T2B" ? 3 : 1 },
    (_, j) => ({
      id: `case-${n}-${j}`,
      number: `DEMO-CASE-${n + 1}-${j + 1}`,
      refId: `GA26-DEMO-${n + 1}${j + 1}`,
      serviceDate: "2026-11-26",
      tenant: `Demo Tenant ${j + 1}`,
      unit: String(101 + j),
      address: "2035 Fictional Example Lane",
      community: "Demo Cedar Community",
    }),
  );
  const invoice = {
    id: `demo-${n}`,
    caseId: caseSnapshots[0].id,
    caseIds: caseSnapshots.map((c) => c.id),
    pricingVersion: 2,
    template,
    caseSnapshots,
    number: `2035-X26-11-26-00000${n + 1}`,
    date: "2026-11-26",
    dueDate: "2026-12-26",
    status: "Sent",
    taxRate: 0,
    discount: template === "T2B" ? 300 : 100,
    lines: caseSnapshots.map((c) => ({
      caseId: c.id,
      description:
        template === "T1"
          ? "Property setout service"
          : "Apartment setout service",
      qty: 1,
      price: 650,
      serviceOutcome: "Cleared",
    })),
  };
  if (template === "T1")
    invoice.lines.push({
      caseId: invoice.caseId,
      description: "Lock exchange",
      qty: 1,
      price: 150,
      serviceOutcome: "Cleared",
    });
  return {
    invoice,
    cases: [],
    customer: {
      company: "Demo Sample Property Holdings LLC",
      name: "Demo Customer",
      email: "customer@example.invalid",
      address: "50 Example Road, Atlanta, GA",
    },
  };
});
const folder = process.argv[2] || "./invoice-previews";
await mkdir(folder, { recursive: true });
await writeFile(
  `${folder}/LegalFlow_Invoice_Template_Previews.pdf`,
  await renderInvoicePdf(records, company),
);
console.log("Generated three fictional invoice templates");
