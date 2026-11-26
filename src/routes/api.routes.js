import * as publicInvoice from "../controllers/public-invoice.controller.js";
import * as invoicePicker from "../controllers/invoice-picker.controller.js";
import * as invoiceDelivery from "../controllers/invoice-delivery.controller.js";
import * as inbox from "../controllers/email-conversations.controller.js";
import * as portfolios from "../controllers/workspaces.controller.js";
import * as singleReport from "../controllers/single-case-report.controller.js";
import * as addresses from "../controllers/addresses.controller.js";
import * as company from "../controllers/company.controller.js";
import * as caseImport from "../controllers/case-import.controller.js";
import * as caseReports from "../controllers/case-reports.controller.js";
import { nativeIdentity } from "../services/mobile-auth.service.js";
import * as mobile from "../controllers/mobile.controller.js";
import * as mail from "../controllers/email.controller.js";
import { Router } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import * as payments from "../controllers/payments.controller.js";
import * as auth from "../controllers/auth.controller.js";
import * as c from "../controllers/resources.controller.js";
import * as d from "../controllers/documents.controller.js";
import { csrf, requireAuth, authThrottle } from "../middleware/auth.js";
import { env } from "../config/env.js";
export const api = Router();
api.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
const mobileAuthLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts" },
});
api.post("/mobile/auth/login", mobileAuthLimit, authThrottle(), mobile.login);
api.post(
  "/mobile/auth/register",
  mobileAuthLimit,
  authThrottle(10),
  mobile.register,
);
api.get("/mobile/payments/return", mobile.paymentReturn);
api.get("/integrations/dropbox/callback", mobile.dropboxCallback);
const publicLimit = rateLimit({
  windowMs: 60000,
  limit: 90,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const publicPayLimit = rateLimit({
  windowMs: 60000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
api.use("/public/invoices", publicInvoice.privateResponse, publicLimit);
api.post("/public/invoices/view", publicInvoice.view);
api.post("/public/invoices/logo", publicInvoice.logo);
api.post("/public/invoices/pdf", rateLimit({windowMs:60000,limit:8,standardHeaders:"draft-8",legacyHeaders:false}), publicInvoice.pdf);
api.post("/public/invoices/status", publicInvoice.status);
api.post("/public/invoices/checkout", publicPayLimit, publicInvoice.checkout);
api.use(nativeIdentity);
api.get("/auth/session", auth.session);
api.use(csrf);
const ipAuth = rateLimit({
  windowMs: 15 * 60000,
  limit: 50,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again later" },
});
api.post("/auth/login", ipAuth, authThrottle(), auth.login);
api.post("/auth/register", ipAuth, authThrottle(10), auth.register);
api.use(requireAuth);
api.get("/mobile/auth/me", (req, res) => res.json({ user: req.publicUser }));
api.post("/mobile/auth/logout", mobile.logout);
api.post("/mobile/integrations/dropbox/connect", mobile.dropboxConnect);
api.post("/auth/logout", auth.logout);
api.patch("/auth/profile", auth.profile);
api.get("/email/recipients", inbox.recipients);
api.get("/email/threads", inbox.list);
api.get("/email/threads/:id", inbox.messages);
api.post("/email/send", rateLimit({ windowMs: 60000, limit: 20 }), inbox.send);
api.post("/email/threads/:id/read", inbox.read);
api.get("/email/attachments/:id", inbox.attachment);
api.get("/email/incoming/status", inbox.status);
api.post("/email/incoming/retry-attachments", inbox.retryAttachments);
api.post(
  "/email/incoming/sync",
  rateLimit({ windowMs: 60000, limit: 2 }),
  inbox.sync,
);
api.get("/workspace", c.getWorkspace);
api.get("/workspaces", portfolios.list);
api.put("/workspaces/:id", portfolios.save);
api.post("/workspaces/:id/archive", portfolios.archive);
api.delete("/workspaces/:id", portfolios.remove);
api.put("/workspace-access", portfolios.access);
api.post("/workspaces/move-cases", portfolios.bulkAssign);
api.patch("/cases/:id/workspace", portfolios.assign);
api.get("/company/profile", company.get);
api.patch("/company/profile", company.update);
api.get("/company/profile/logo", company.logo);
api.get("/addresses/config", addresses.config);
const placesLimit = rateLimit({ windowMs: 60000, limit: 120 });
api.post("/addresses/suggest", placesLimit, addresses.suggest);
api.post("/addresses/details", placesLimit, addresses.details);
api.get("/email/status", mail.emailStatus);
const emailAdminLimit = rateLimit({
  windowMs: 60000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Wait a minute before trying email diagnostics again" },
});
api.post("/email/verify", emailAdminLimit, mail.verifyEmail);
api.post("/email/retry", emailAdminLimit, mail.retryEmails);
api.get("/invoice-picker", invoicePicker.search);
api.get("/payments/config", payments.configuration);
api.post("/invoices/:id/checkout", payments.checkout);
api.post("/invoices/:id/payment-status", payments.status);
api.post("/users", c.createUser);
api.put("/permissions/:role", c.updatePermissions);
api.patch("/users/:id/access", c.updateUser);
api.delete("/users/:id", c.deleteUser);
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 1,
    fieldSize: 100000,
  },
});
const importLimit = rateLimit({
  windowMs: 60000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
api.post(
  "/cases/import/preview",
  importLimit,
  importUpload.single("file"),
  caseImport.preview,
);
api.post("/cases/import/commit", importLimit, caseImport.commit);
api.post(
  "/reports/cases/email",
  rateLimit({ windowMs: 60000, limit: 5 }),
  caseReports.email,
);
api.patch("/cases/bulk", importLimit, caseImport.bulkUpdate);
api.get("/cases/:id/report/pdf", importLimit, singleReport.pdf);
api.post(
  "/cases/:id/report/email",
  rateLimit({ windowMs: 60000, limit: 5 }),
  singleReport.email,
);
api.put("/cases/:id", c.putCase);
api.delete("/cases/:id", c.deleteCase);
api.post("/cases/:id/comments", c.comment);
api.put("/clients/:id", c.putClient);
api.delete("/clients/:id", c.deleteClient);
api.post("/invoices/:id/public-link", publicInvoice.link);
api.delete("/invoices/:id/public-links", publicInvoice.revoke);
api.get("/invoices/:id/pdf", invoiceDelivery.pdf);
api.post("/invoices/:id/email", invoiceDelivery.email);
api.get("/cases/:id/invoices/pdf", invoiceDelivery.bundle);
api.put("/invoices/:id", c.putInvoice);
api.delete("/invoices/:id", c.deleteInvoice);
api.put("/events/:id", c.putEvent);
api.delete("/events/:id", c.deleteEvent);
api.patch("/preferences", c.preferences);
api.post("/notifications/read", c.readNotifications);
api.put("/custom-fields/:id", c.putField);
api.delete("/custom-fields/:id", c.deleteField);
api.post("/conversations", c.startChat);
api.post("/conversations/:id/messages", c.sendMessage);
api.post("/conversations/:id/read", c.readChat);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_FILE_MB * 1024 * 1024,
    files: 1,
    fields: 1,
    fieldSize: 100,
    parts: 2,
  },
});
const uploadLimit = rateLimit({
  windowMs: 60000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many uploads. Try again in a minute" },
});
api.post("/documents", uploadLimit, upload.single("file"), d.upload);
api.get("/documents/:id/content", d.content);
api.delete("/documents/:id", d.remove);
api.get("/integrations/dropbox", d.status);
api.post("/integrations/dropbox/connect", d.connect);
api.get("/integrations/dropbox/callback", d.callback);
