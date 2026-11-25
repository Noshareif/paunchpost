import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "./db";

const root = process.cwd();

/** Creates/updates the tables. Safe to run any number of times. */
export async function migrate() {
  const schema = await readFile(path.join(root, "db/schema.sql"), "utf8");
  await db().unsafe(schema);
}

let ensured: Promise<void> | null = null;
/** Runs the (idempotent) schema once per server process, so new columns appear after a deploy. */
export function ensureSchema() {
  if (!ensured) ensured = migrate().catch(e => { ensured = null; throw e; });
  return ensured;
}

/** Loads the Mailchimp history (campaigns + templates). Safe to re-run: matched by Mailchimp ID. */
export async function importMailchimp() {
  const sql = db();
  const data = JSON.parse(await readFile(path.join(root, "data/mailchimp.json"), "utf8"));
  const [{ id: senderId }] = await sql`select id from senders where is_default order by id limit 1`;
  for (const tp of data.templates || []) {
    await sql`insert into templates (name, html, mc_id) values (${tp.name}, ${tp.html}, ${String(tp.mcId)})
      on conflict (mc_id) do update set name = excluded.name, html = excluded.html, updated_at = now()`;
  }
  for (const m of data.campaigns || []) {
    const status = m.status === "sent" ? "sent" : "draft";
    const stats = m.stats ? { ...m.stats, links: m.links || [], series: m.series || [] } : null;
    const audience = (m.audience || "") + (m.segment && !/^All (email )?subscribers$/i.test(m.segment) ? " · " + m.segment : "");
    await sql`
      insert into campaigns (name, subject, preview, status, sender_id, html, send_at, started_at, finished_at,
                             imported, imported_stats, imported_audience, mc_id, created_at, updated_at)
      values (${m.name}, ${m.subject || ""}, ${m.preview || ""}, ${status}, ${senderId}, ${m.html || ""},
              ${m.sendAt}, ${m.sendAt}, ${m.sendAt}, true, ${stats ? sql.json(stats) : null}, ${audience}, ${String(m.mcId)},
              ${m.created || new Date().toISOString()}, ${m.edited || m.created || new Date().toISOString()})
      on conflict (mc_id) do update set
        name = excluded.name, subject = excluded.subject, preview = excluded.preview, html = excluded.html,
        imported_stats = excluded.imported_stats, imported_audience = excluded.imported_audience,
        status = case when campaigns.status in ('sent','draft') then excluded.status else campaigns.status end,
        send_at = excluded.send_at, updated_at = excluded.updated_at`;
  }
  return { templates: (data.templates || []).length, campaigns: (data.campaigns || []).length };
}
