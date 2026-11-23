// Loads your Mailchimp history (campaigns, their stats and templates) into PaunchPost.
// Safe to run again: rows are matched by their Mailchimp ID and updated.
//   npm run import:mailchimp            (uses data/mailchimp.json)
import { readFile } from "node:fs/promises";
import { connect } from "./db.mjs";

const file = process.argv[2] || new URL("../data/mailchimp.json", import.meta.url);
const data = JSON.parse(await readFile(file, "utf8"));
const sql = connect();
const [{ id: senderId }] = await sql`select id from senders where is_default order by id limit 1`;

let t = 0;
for (const tp of data.templates || []) {
  await sql`
    insert into templates (name, html, mc_id) values (${tp.name}, ${tp.html}, ${String(tp.mcId)})
    on conflict (mc_id) do update set name = excluded.name, html = excluded.html, updated_at = now()`;
  t++;
}

let c = 0;
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
  c++;
}
const [{ n }] = await sql`select count(*)::int as n from campaigns where imported`;
console.log(`Imported ${t} templates and ${c} campaigns (${n} Mailchimp campaigns now in PaunchPost).`);
await sql.end();
