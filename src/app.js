import express from "express";
import helmet from "helmet";
import session from "express-session";
import PgStore from "connect-pg-simple";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { env } from "./config/env.js";
import { pool } from "./config/database.js";
import { api } from "./routes/api.routes.js";
import { webhook as stripeWebhook } from "./controllers/payments.controller.js";
import { errorHandler } from "./utils/errors.js";
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader("X-Request-Id", req.id);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "blob:", "data:"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ["'self'"],
          mediaSrc: ["'self'", "blob:"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: env.NODE_ENV === "production" ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.get("/api/health/live", (req, res) => res.json({ ok: true }));
  app.get("/api/health/ready", async (req, res) => {
    await pool.query("SELECT 1 FROM legalflow.migrations LIMIT 1");
    await pool.query("SELECT 1 FROM legalflow.invoice_payments LIMIT 1");
    await pool.query(
      "SELECT manager_id,permissions FROM legalflow.users LIMIT 1",
    );
    await pool.query("SELECT deleted_at FROM legalflow.invoices LIMIT 1");
    res.json({ ok: true });
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 400,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Please wait a minute" },
    }),
  );
  // Stripe signs the exact bytes. This route must precede JSON parsing and browser CSRF/session middleware.
  app.post(
    "/api/payments/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    stripeWebhook,
  );
  app.use("/api", express.json({ limit: "1mb" }));
  const Store = PgStore(session);
  app.use(
    "/api",
    session({
      name: "legalflow.sid",
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new Store({
        pool,
        schemaName: "legalflow",
        tableName: "sessions",
        createTableIfMissing: false,
        pruneSessionInterval: 900,
      }),
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/api",
        maxAge: 7 * 86400000,
      },
    }),
  );
  app.use("/api", api);
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API endpoint not found" }),
  );
  const dist = path.resolve(env.FRONTEND_DIST);
  if (existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist, { index: false }));
    app.get("/{*splat}", (req, res) =>
      res.sendFile(path.join(dist, "index.html")),
    );
  }
  app.use(errorHandler);
  return app;
}
