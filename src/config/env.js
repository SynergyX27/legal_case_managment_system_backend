import "dotenv/config";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
// Optional private SMTP overlay. Existing .env / Render variables take priority.
if (process.env.NODE_ENV !== "test")
  dotenv.config({
    path: fileURLToPath(new URL("../../.env.smtp", import.meta.url)),
    quiet: true,
  });
import { z } from "zod";
const schema = z.object({
  SMTP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SMTP_HOST: z.string().trim().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().trim().default(""),
  SMTP_PASSWORD: z.string().default(""),
  MAIL_FROM: z.union([z.literal(""), z.string().email()]).default(""),
  MAIL_FROM_NAME: z.string().trim().max(100).default("LegalFlow"),
  EMAIL_POLL_SECONDS: z.coerce.number().int().min(2).max(300).default(10),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  DB_SSL_MODE: z.enum(["verify-full", "disable"]).default("verify-full"),
  SESSION_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url(),
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  STRIPE_SECRET_KEY: z
    .union([z.literal(""), z.string().regex(/^sk_(test|live)_/)])
    .default(""),
  STRIPE_WEBHOOK_SECRET: z
    .union([z.literal(""), z.string().startsWith("whsec_")])
    .default(""),
  DROPBOX_APP_KEY: z.string().default(""),
  DROPBOX_APP_SECRET: z.string().default(""),
  DROPBOX_REFRESH_TOKEN: z.string().default(""),
  DROPBOX_REDIRECT_URI: z.string().url(),
  DROPBOX_ROOT: z
    .string()
    .regex(/^\/[A-Za-z0-9_/-]+$/)
    .default("/LegalFlow"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  MAX_FILE_MB: z.coerce.number().int().min(1).max(100).default(25),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  FRONTEND_DIST: z.string().default("../frontend/dist"),
});
export const env = schema.parse(process.env);
if (env.NODE_ENV === "production" && !env.APP_ORIGIN.startsWith("https://"))
  throw new Error("Production requires an HTTPS APP_ORIGIN");
if (new URL(env.DROPBOX_REDIRECT_URI).origin !== new URL(env.APP_ORIGIN).origin)
  throw new Error("Dropbox redirect must use APP_ORIGIN");

if (
  env.SMTP_ENABLED &&
  (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.MAIL_FROM)
)
  throw new Error(
    "Enabled email requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD and MAIL_FROM",
  );
if (env.SMTP_ENABLED && env.SMTP_PORT === 465 && !env.SMTP_SECURE)
  throw new Error("SMTP port 465 requires SMTP_SECURE=true");
