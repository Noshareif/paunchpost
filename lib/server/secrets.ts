import crypto from "node:crypto";

/**
 * Internal secrets (CRON_SECRET, SES_WEBHOOK_KEY). If not set in Vercel, they're derived from the
 * database password Neon already put there, so nobody has to invent and paste them.
 * Setting the variable explicitly in Vercel overrides the derived value.
 */
export function secret(name: "CRON_SECRET" | "SES_WEBHOOK_KEY"): string | null {
  if (process.env[name]) return process.env[name]!;
  const base = process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || process.env.DATABASE_URL;
  if (!base) return null;
  return crypto.createHmac("sha256", base).update("paunchpost:" + name).digest("hex");
}
