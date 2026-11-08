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
api.post("/auth/logout", auth.logout);
api.patch("/auth/profile", auth.profile);
api.get("/workspace", c.getWorkspace);
api.get("/payments/config", payments.configuration);
api.post("/invoices/:id/checkout", payments.checkout);
api.post("/invoices/:id/payment-status", payments.status);
api.post("/users", c.createUser);
api.put("/permissions/:role", c.updatePermissions);
api.patch("/users/:id/access", c.updateUser);
api.put("/cases/:id", c.putCase);
api.delete("/cases/:id", c.deleteCase);
api.post("/cases/:id/comments", c.comment);
api.put("/clients/:id", c.putClient);
api.delete("/clients/:id", c.deleteClient);
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
