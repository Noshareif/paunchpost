import { after } from "next/server";
import { baseUrl, processBatch, startDueCampaigns } from "./send";
import { db } from "./db";
import { secret as getSecret } from "./secrets";
import { ensureSchema } from "./setup";

export function authorized(req: Request): boolean {
  const secret = getSecret("CRON_SECRET");
  if (!secret) return false;
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${secret}`;
}

/** Asks the app to run another batch right after this response (keeps a big send moving). */
export function kickWorker() {
  const secret = getSecret("CRON_SECRET");
  if (!secret) return;
  after(async () => {
    try {
      await fetch(`${baseUrl()}/api/worker`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    } catch (e) {
      console.error("could not kick worker", e);
    }
  });
}

/** A 90-second lease so only one worker sends at a time, however many times it gets woken up. */
async function takeLease(): Promise<boolean> {
  const sql = db();
  const until = new Date(Date.now() + 90_000).toISOString();
  const r = await sql`
    insert into settings (key, value) values ('worker_lease', ${sql.json(until)})
    on conflict (key) do update set value = excluded.value
    where (settings.value #>> '{}')::timestamptz < now()
    returning key`;
  return r.length > 0;
}
async function dropLease() {
  await db()`update settings set value = '"1970-01-01T00:00:00Z"' where key = 'worker_lease'`;
}

/** One unit of work: start due scheduled campaigns, send a batch, chain if more is waiting. */
export async function tick() {
  await ensureSchema();
  if (!(await takeLease())) return { busy: true };
  let more = false;
  try {
    const started = await startDueCampaigns();
    const r = await processBatch({ limit: 250, deadlineMs: 40_000 });
    more = r.remaining > 0;
    return { started, ...r };
  } finally {
    await dropLease();
    if (more) kickWorker();
  }
}

/**
 * The public heartbeat (/api/tick), safe to call by anyone: it never sends anything that
 * wasn't already scheduled or queued, at most once a minute, through the single worker above.
 */
export async function heartbeat() {
  await ensureSchema();
  const sql = db();
  const r = await sql`
    insert into settings (key, value) values ('last_tick_at', ${sql.json(new Date().toISOString())})
    on conflict (key) do update set value = excluded.value
    where (settings.value #>> '{}')::timestamptz < now() - interval '50 seconds'
    returning key`;
  if (!r.length) return { skipped: true };
  const [{ due }] = await sql`select count(*)::int as due from campaigns where status = 'scheduled' and send_at <= now()`;
  const [{ queued }] = await sql`select count(*)::int as queued from sends s join campaigns c on c.id = s.campaign_id
    where s.status = 'queued' and c.paused_reason is null`;
  if (due || queued) kickWorker();
  return { due, queued };
}
