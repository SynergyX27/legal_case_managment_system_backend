import { z } from "zod";
const text = z.string().trim().max(10000);
const short = z.string().trim().max(250);
const optional = short.default("");
export const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const role = z.enum(["owner", "manager", "staff", "customer"]);
export const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128);
export const userInput = z.object({
  name: short.min(2),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .transform((v) => v.toLowerCase()),
  password,
  phone: optional,
  address: text.default(""),
  title: optional,
  clientId: optional,
  role: role.default("customer"),
});
export const accessInput = z.object({
  role,
  status: z.enum(["Active", "Inactive"]),
  password: password.optional(),
});
export const clientInput = z.object({
  id,
  name: short.min(2),
  email: z.string().trim().email(),
  phone: optional,
  address: text.default(""),
  status: z.enum(["Active", "On Hold", "Inactive"]).default("Active"),
});
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Invalid calendar date",
  );
const maybeDate = z.union([z.literal(""), date]).default("");
export const caseInput = z.object({
  id,
  number: short.min(1),
  title: short.min(1),
  clientId: id,
  residentName: short.min(1),
  residentAddress: text.default(""),
  residentPhone: optional,
  description: text.default(""),
  type: short.min(1),
  status: z.enum(["Active", "Pending", "Scheduled", "Completed", "Cancelled"]),
  priority: z.enum(["Low", "Medium", "High", "Urgent"]),
  notes: text.default(""),
  serviceDate: maybeDate,
  serviceTime: z
    .union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)])
    .default(""),
  staffId: optional,
  managerId: optional,
  serviceLocation: optional,
  instructions: text.default(""),
  court: optional,
  jurisdiction: optional,
  custom: z
    .record(z.union([z.string().max(10000), z.number().finite(), z.boolean()]))
    .default({}),
  ref: optional,
  plaintiff: optional,
  county: optional,
  city: optional,
  state: optional,
  zip: optional,
  visLO: optional,
  visTO: optional,
  locs: optional,
  lbx: optional,
});
export const invoiceInput = z
  .object({
    id,
    caseId: id,
    clientId: id,
    date,
    dueDate: date,
    lines: z
      .array(
        z.object({
          description: short.min(1),
          qty: z.number().finite().positive().max(100000),
          price: z.number().finite().min(0).max(10000000),
        }),
      )
      .min(1)
      .max(200),
    taxRate: z.number().finite().min(0).max(100),
    status: z.enum(["Draft", "Sent", "Paid", "Overdue"]),
  })
  .refine((v) => v.dueDate >= v.date, {
    message: "Due date cannot precede invoice date",
    path: ["dueDate"],
  });
export const eventInput = z.object({
  id,
  title: short.min(1),
  date,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  staffId: optional,
  location: optional,
  notes: text.default(""),
});
export const messageInput = z.object({ text: text.min(1) });
export const preferenceInput = z.object({
  savedViews: z
    .array(
      z.object({
        id,
        name: short.min(1),
        filters: z.object({
          status: z.array(short).max(10),
          clientId: optional,
          staffId: optional,
          type: optional,
          dateFrom: maybeDate,
          dateTo: maybeDate,
          mine: z.boolean().optional(),
          search: optional,
        }),
      }),
    )
    .max(100)
    .optional(),
  tablePrefs: z
    .object({
      visible: z.array(short).max(60),
      order: z.array(short).max(60),
      widths: z.record(z.number().min(20).max(2000)),
      pageSize: z.number().int().min(5).max(500),
    })
    .nullable()
    .optional(),
});
export const customFieldInput = z.object({
  id,
  label: short.min(1),
  type: z.enum([
    "text",
    "number",
    "date",
    "dropdown",
    "checkbox",
    "email",
    "phone",
    "textarea",
  ]),
  required: z.boolean(),
  options: z.array(short).max(100),
});
