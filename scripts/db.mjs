// Shared connection for the scripts in this folder.
import postgres from "postgres";
export function connect() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error("Set DATABASE_URL first (copy it from Vercel → Storage → your database → .env.local tab).");
    process.exit(1);
  }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, { ssl: local ? false : "require", max: 2, onnotice: () => {} });
}
