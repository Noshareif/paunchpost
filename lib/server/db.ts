import postgres from "postgres";

// Vercel's Neon integration sets DATABASE_URL (and POSTGRES_URL). Either works.
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

declare global {
  // eslint-disable-next-line no-var
  var __pp_sql: ReturnType<typeof postgres> | undefined;
}

function make() {
  if (!url) throw new Error("DATABASE_URL is not set. Connect a Postgres database in Vercel → Storage.");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, {
    ssl: local ? false : "require",
    max: 5,
    idle_timeout: 20,
    prepare: false, // works with Neon's connection pooler
    transform: { undefined: null },
  });
}

/** Shared connection pool (reused across hot reloads and warm serverless invocations). */
export function db() {
  if (!globalThis.__pp_sql) globalThis.__pp_sql = make();
  return globalThis.__pp_sql;
}

export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const rows = await db()`select value from settings where key = ${key}`;
  return rows.length ? (rows[0].value as T) : fallback;
}
