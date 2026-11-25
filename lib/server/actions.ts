// Everything the interface can read or change. Called through /api/state and /api/rpc.
import { db, getSetting } from "./db";
import { countRecipients, type Audience, type Cond } from "./audience";
import { startCampaign, sendTest, SendError } from "./send";
import { kickWorker } from "./worker";
import { ensureSchema } from "./setup";
import { connectFeed as connectFeedAws, feedStatus } from "./feed";
import { spamCheck as lint } from "./spamcheck";
import { baseUrl, readiness } from "./send";

const sql = () => db();
type Row = Record<string, any>;

export class ActionError extends Error {}
const fail = (m: string): never => {
  throw new ActionError(m);
};
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail("Bad id");
  return n;
};

/* ---------------- settings ---------------- */
const SETTING_KEYS = ["company", "footer_address", "default_reminder", "track_opens", "track_clicks", "require_permission", "custom_fields", "max_per_campaign", "max_per_day", "send_rate"] as const;

async function settings() {
  const rows = await sql()`select key, value from settings`;
  const m: Row = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    company: m.company ?? "Darkhorse Tech",
    footerAddress: m.footer_address ?? "",
    reminder: m.default_reminder ?? "",
    trackOpens: m.track_opens ?? true,
    trackClicks: m.track_clicks ?? true,
    requirePermission: m.require_permission ?? true,
    fields: Array.isArray(m.custom_fields) ? m.custom_fields : [],
    maxPerCampaign: Number(m.max_per_campaign ?? 3000),
    maxPerDay: Number(m.max_per_day ?? 4000),
    sendRate: Number(m.send_rate ?? 5),
  };
}

/* ---------------- stats ---------------- */
function campaignOut(c: Row) {
  let stats: Row | null = null;
  if (c.imported && c.imported_stats) {
    const { links, series, ...rest } = c.imported_stats;
    stats = rest;
  } else if (["sending", "sent"].includes(c.status)) {
    stats = {
      recipients: c.s_recipients,
      delivered: c.s_delivered,
      bounces: c.s_bounces,
      opens: c.s_opens,
      totalOpens: c.s_total_opens,
      clicks: c.s_clicks,
      totalClicks: c.s_total_clicks,
      unsubs: c.s_unsubs,
      complaints: c.s_complaints,
      queued: c.s_queued,
      failed: c.s_failed,
    };
  }
  return {
    id: c.id,
    name: c.name,
    subject: c.subject,
    preview: c.preview,
    status: c.status,
    senderId: c.sender_id,
    audience: c.audience || {},
    audienceLabel: c.imported_audience || null,
    pausedReason: c.paused_reason || null,
    templateId: c.template_id,
    trackOpens: c.track_opens,
    trackClicks: c.track_clicks,
    sendAt: c.send_at,
    editedAt: c.updated_at,
    createdAt: c.created_at,
    imported: c.imported,
    plain: c.plain,
    stats,
  };
}

const CAMPAIGN_COLS = (s: ReturnType<typeof sql>) => s`
  c.id, c.name, c.subject, c.preview, c.status, c.sender_id, c.audience, c.template_id, c.track_opens, c.track_clicks,
  c.send_at, c.updated_at, c.created_at, c.imported, c.imported_stats - 'series' - 'links' as imported_stats, c.imported_audience, c.plain, c.paused_reason,
  coalesce(st.recipients, 0) as s_recipients, coalesce(st.delivered, 0) as s_delivered, coalesce(st.bounces, 0) as s_bounces,
  coalesce(st.opens, 0) as s_opens, coalesce(st.total_opens, 0) as s_total_opens, coalesce(st.clicks, 0) as s_clicks,
  coalesce(st.total_clicks, 0) as s_total_clicks, coalesce(st.unsubs, 0) as s_unsubs, coalesce(st.complaints, 0) as s_complaints,
  coalesce(st.queued, 0) as s_queued, coalesce(st.failed, 0) as s_failed`;

const STATS_JOIN = (s: ReturnType<typeof sql>) => s`
  left join lateral (
    select count(*) filter (where status in ('sent','bounced','complained'))::int as recipients,
           count(*) filter (where status in ('sent','complained'))::int as delivered,
           count(*) filter (where status = 'bounced')::int as bounces,
           count(opened_at)::int as opens, coalesce(sum(open_count), 0)::int as total_opens,
           count(clicked_at)::int as clicks, coalesce(sum(click_count), 0)::int as total_clicks,
           count(unsubscribed_at)::int as unsubs, count(*) filter (where status = 'complained')::int as complaints,
           count(*) filter (where status in ('queued','sending'))::int as queued,
           count(*) filter (where status = 'failed')::int as failed
    from sends where campaign_id = c.id and not c.imported
  ) st on true`;

/* ---------------- state ---------------- */
export async function getState() {
  await ensureSchema();
  const s = sql();
  const [st, senders, lists, tags, segments, templates, campaigns, suppression, imports, images, totals] = await Promise.all([
    settings(),
    s`select id, name, email, reply_to, is_default from senders order by id`,
    s`select l.id, l.name, l.description, l.sender_id, l.reminder, l.created_at,
         count(m.contact_id)::int as size,
         count(m.contact_id) filter (where c.status = 'subscribed')::int as subs
       from lists l left join list_members m on m.list_id = l.id left join contacts c on c.id = m.contact_id
       group by l.id order by l.created_at desc`,
    s`select tag, count(*)::int as n,
         count(*) filter (where c.status = 'subscribed')::int as subs
       from contact_tags t join contacts c on c.id = t.contact_id group by tag order by lower(tag)`,
    s`select id, name, match, conditions from segments order by id`,
    s`select id, name, html, updated_at from templates order by updated_at desc`,
    s`select ${CAMPAIGN_COLS(s)} from campaigns c ${STATS_JOIN(s)} order by coalesce(c.send_at, c.updated_at) desc`,
    s`select email, reason, source, created_at from suppressions order by created_at desc limit 5000`,
    s`select * from imports order by at desc limit 200`,
    s`select id, name, url, created_at from images order by created_at desc`,
    s`select count(*)::int as contacts, count(*) filter (where status = 'subscribed')::int as subscribed,
         (select count(*)::int from suppressions) as suppressed from contacts`,
  ]);
  const defaultSender = senders.find(x => x.is_default)?.id ?? senders[0]?.id ?? null;
  return {
    settings: { ...st, defaultSender },
    senders: senders.map(x => ({ id: x.id, name: x.name, email: x.email, replyTo: x.reply_to || x.email })),
    lists: lists.map(l => ({ id: l.id, name: l.name, note: l.description || "", senderId: l.sender_id, reminder: l.reminder || "", created: l.created_at, size: l.size, subs: l.subs })),
    tags: tags.map(t => ({ tag: t.tag, n: t.n, subs: t.subs })),
    segments: segments.map(g => ({ id: g.id, name: g.name, match: g.match, conds: g.conditions })),
    templates: templates.map(t => ({ id: t.id, name: t.name, html: t.html, edited: t.updated_at })),
    campaigns: campaigns.map(campaignOut),
    suppression: suppression.map(x => ({ email: x.email, reason: x.reason, source: x.source, date: x.created_at })),
    imports: imports.map(i => ({ id: i.id, date: i.at, method: i.method, file: i.file || "—", list: i.list_name || "", added: i.added, updated: i.updated, skipped: i.skipped })),
    images: images.map(i => ({ id: i.id, name: i.name, url: i.url, date: i.created_at })),
    totals: totals[0],
  };
}

/* ---------------- campaigns ---------------- */
const CAMPAIGN_FIELDS: Record<string, string> = {
  name: "name", subject: "subject", preview: "preview", html: "html", plain: "plain", senderId: "sender_id",
  audience: "audience", templateId: "template_id", trackOpens: "track_opens", trackClicks: "track_clicks",
};

async function getCampaign({ id }: Row) {
  const s = sql();
  const [c] = await s`select ${CAMPAIGN_COLS(s)}, c.html from campaigns c ${STATS_JOIN(s)} where c.id = ${num(id)}`;
  if (!c) fail("Campaign not found.");
  return { ...campaignOut(c), html: c.html };
}

async function createCampaign({ name, from }: Row) {
  const s = sql();
  const st = await settings();
  const [snd] = await s`select id from senders order by is_default desc, id limit 1`;
  let html = "", subject = "", preview = "", templateId: number | null = null, audience: Row = {}, senderId = snd?.id ?? null;
  if (typeof from === "string" && from.startsWith("t:")) {
    const [t] = await s`select id, html from templates where id = ${num(from.slice(2))}`;
    if (t) { html = t.html; templateId = t.id; }
  } else if (typeof from === "string" && from.startsWith("c:")) {
    const [c] = await s`select * from campaigns where id = ${num(from.slice(2))}`;
    if (c) { html = c.html; subject = c.subject; preview = c.preview; templateId = c.template_id; senderId = c.sender_id ?? senderId; if (!c.imported) audience = c.audience; }
  } else if (typeof from === "string" && from.startsWith("html:")) {
    html = from.slice(5);
  }
  const [c] = await s`
    insert into campaigns (name, subject, preview, html, template_id, sender_id, audience, track_opens, track_clicks)
    values (${String(name || "Untitled").slice(0, 200)}, ${subject}, ${preview}, ${html}, ${templateId}, ${senderId}, ${s.json(audience)}, ${!!st.trackOpens}, ${!!st.trackClicks})
    returning id`;
  return { id: c.id };
}

async function updateCampaign({ id, patch }: Row) {
  const s = sql();
  const cid = num(id);
  const [c] = await s`select status, imported from campaigns where id = ${cid}`;
  if (!c) fail("Campaign not found.");
  const onlyName = Object.keys(patch || {}).every(k => k === "name");
  if (!onlyName && !["draft", "scheduled"].includes(c.status)) fail("Sent campaigns can’t be edited. Replicate it instead.");
  const set: Row = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const col = CAMPAIGN_FIELDS[k];
    if (!col) continue;
    set[col] = k === "audience" ? s.json(((v as object) || {}) as any) : v;
  }
  if (patch && "sendAt" in patch) {
    // Drafts keep a planned date for the calendar; scheduled campaigns can be moved to a new time.
    const v = patch.sendAt ? new Date(patch.sendAt) : null;
    if (v && isNaN(+v)) fail("That date doesn’t look right.");
    if (c.status === "scheduled") {
      if (!v || +v < Date.now() + 60_000) fail("Pick a time at least a minute from now.");
    }
    set.send_at = v;
  }
  if (!Object.keys(set).length) return { ok: true };
  await s`update campaigns set ${s(set)}, updated_at = now() where id = ${cid}`;
  return { ok: true };
}

async function deleteCampaigns({ ids }: Row) {
  const list = (ids as unknown[]).map(num);
  const busy = await sql()`select id from campaigns where id = any(${list}) and status = 'sending'`;
  if (busy.length) fail("A campaign is sending right now and can’t be deleted.");
  await sql()`delete from campaigns where id = any(${list})`;
  return { ok: true };
}

async function unschedule({ id }: Row) {
  await sql()`update campaigns set status = 'draft', updated_at = now() where id = ${num(id)} and status = 'scheduled'`;
  return { ok: true };
}

async function countAudience({ audience }: Row) {
  return { n: await countRecipients((audience || {}) as Audience) };
}

async function send({ id, confirm, sendAt }: Row) {
  const cid = num(id);
  if (confirm !== true) fail("Confirm that everyone on this list asked to hear from Darkhorse Tech.");
  try {
    if (sendAt) {
      const when = new Date(sendAt);
      if (isNaN(+when) || +when < Date.now() + 60_000) fail("Pick a time at least a minute from now.");
      const r = await sql()`update campaigns set status = 'scheduled', send_at = ${when}, updated_at = now() where id = ${cid} and status in ('draft','scheduled') returning id`;
      if (!r.length) fail("Only drafts can be scheduled.");
      return { scheduled: when.toISOString() };
    }
    const r = await startCampaign(cid);
    kickWorker();
    return r;
  } catch (e) {
    if (e instanceof SendError) fail(e.message);
    throw e;
  }
}

async function test({ id, to, contactId }: Row) {
  const list = (Array.isArray(to) ? to : String(to || "").split(",")).map((x: unknown) => String(x).trim()).filter(Boolean);
  if (!list.length || list.length > 5 || list.some(e => !EMAIL.test(e))) fail("Enter up to 5 valid email addresses.");
  try {
    await sendTest(num(id), list, contactId ? Number(contactId) : undefined);
  } catch (e) {
    if (e instanceof SendError) fail(e.message);
    fail("Amazon SES didn’t accept the test email: " + (e as Error).message);
  }
  return { ok: true };
}

/** Report data for one campaign. Imported Mailchimp campaigns carry their own totals. */
async function report({ id, recipients: rstatus }: Row) {
  const s = sql();
  const cid = num(id);
  const [c] = await s`select id, imported, imported_stats, send_at, started_at from campaigns where id = ${cid}`;
  if (!c) fail("Campaign not found.");
  if (c.imported) {
    const st = c.imported_stats || {};
    return { imported: true, links: (st.links || []).map((l: Row) => ({ url: l.url, total: l.clicks, unique: l.clicks })), series: st.series || [], lastOpened: st.lastOpened || null };
  }
  const start = c.started_at || c.send_at;
  const links = await s`
    select l.url, count(k.id)::int as total, count(distinct k.send_id)::int as unique
    from links l left join clicks k on k.link_id = l.id where l.campaign_id = ${cid} group by l.id order by total desc, l.id`;
  const opens = await s`
    select floor(extract(epoch from (opened_at - ${start})) / 3600)::int as h, count(*)::int as n
    from sends where campaign_id = ${cid} and opened_at is not null and opened_at < ${start}::timestamptz + interval '24 hours' group by 1`;
  const clicks = await s`
    select floor(extract(epoch from (k.at - ${start})) / 3600)::int as h, count(*)::int as n
    from clicks k join sends x on x.id = k.send_id where x.campaign_id = ${cid} and k.at < ${start}::timestamptz + interval '24 hours' group by 1`;
  const series = Array.from({ length: 24 }, (_, h) => ({
    t: new Date(new Date(start).getTime() + h * 3600e3).toISOString(),
    o: opens.find(r => r.h === h)?.n || 0,
    c: clicks.find(r => r.h === h)?.n || 0,
  }));
  const domains = await s`
    select split_part(email, '@', 2) as d, count(*)::int as n,
      count(*) filter (where status = 'bounced')::int as b, count(opened_at)::int as o, count(clicked_at)::int as cl
    from sends where campaign_id = ${cid} and status not in ('queued','sending','skipped') group by 1 order by n desc limit 15`;
  const filter = String(rstatus || "sent");
  const where =
    filter === "opened" ? s`and s.opened_at is not null` :
    filter === "notopened" ? s`and s.opened_at is null and s.status = 'sent'` :
    filter === "clicked" ? s`and s.clicked_at is not null` :
    filter === "bounced" ? s`and s.status = 'bounced'` :
    filter === "unsubscribed" ? s`and s.unsubscribed_at is not null` :
    filter === "complaints" ? s`and s.status = 'complained'` :
    filter === "failed" ? s`and s.status = 'failed'` : s``;
  const recips = await s`
    select s.contact_id, s.email, s.status, s.open_count, s.click_count, s.opened_at, s.clicked_at, s.unsubscribed_at, s.error,
      coalesce(c.first_name, '') as first, coalesce(c.last_name, '') as last, coalesce(c.practice, '') as practice
    from sends s left join contacts c on c.id = s.contact_id
    where s.campaign_id = ${cid} and s.status not in ('queued','sending') ${where} order by s.email limit 2000`;
  const [{ total }] = await s`select count(*)::int as total from sends where campaign_id = ${cid} and status not in ('queued','sending')`;
  return { imported: false, links, series, domains, recipients: recips, recipientTotal: total };
}

/* ---------------- audiences (lists) ---------------- */
async function createList({ name, description, senderId, reminder }: Row) {
  const n = String(name || "").trim();
  if (!n) fail("Name the audience.");
  try {
    const [l] = await sql()`insert into lists (name, description, sender_id, reminder) values (${n}, ${description || null}, ${senderId || null}, ${reminder || null}) returning id`;
    return { id: l.id };
  } catch (e: any) {
    if (e?.code === "23505") fail("An audience with that name already exists.");
    throw e;
  }
}
async function updateList({ id, patch }: Row) {
  const set: Row = {};
  if ("name" in patch) set.name = String(patch.name).trim() || fail("Name the audience.");
  if ("note" in patch) set.description = patch.note;
  if ("senderId" in patch) set.sender_id = patch.senderId || null;
  if ("reminder" in patch) set.reminder = patch.reminder || null;
  if (Object.keys(set).length) await sql()`update lists set ${sql()(set)} where id = ${num(id)}`;
  return { ok: true };
}
async function deleteList({ id }: Row) {
  const lid = num(id);
  const s = sql();
  // Keep the audience's name on campaigns that used it, then drop it from drafts.
  await s`update campaigns set audience = jsonb_set(audience, '{listIds}', coalesce((select jsonb_agg(x) from jsonb_array_elements(audience->'listIds') x where x::int <> ${lid}), '[]'))
          where audience ? 'listIds' and status in ('draft','scheduled')`;
  await s`delete from lists where id = ${lid}`;
  return { ok: true };
}

/* ---------------- contacts ---------------- */
function contactFilter(f: Row) {
  const s = sql();
  const parts = [s`true`];
  if (f.q) parts.push(s`(c.email ilike ${"%" + f.q + "%"} or c.first_name ilike ${"%" + f.q + "%"} or c.last_name ilike ${"%" + f.q + "%"} or c.practice ilike ${"%" + f.q + "%"})`);
  if (f.list && f.list !== "all") parts.push(s`exists (select 1 from list_members m where m.contact_id = c.id and m.list_id = ${num(f.list)})`);
  if (f.status && f.status !== "all") parts.push(s`c.status = ${f.status}`);
  if (f.tag && f.tag !== "all") parts.push(s`exists (select 1 from contact_tags t where t.contact_id = c.id and t.tag = ${f.tag})`);
  if (f.source && f.source !== "all") parts.push(s`c.source = ${f.source}`);
  return parts.slice(1).reduce((a, p) => s`${a} and ${p}`, parts[0]);
}

async function contacts(f: Row) {
  const s = sql();
  const per = 25;
  const page = Math.max(1, Number(f.page) || 1);
  let where = contactFilter(f);
  if (f.seg) {
    const { segmentMatchSql } = await import("./segment-match");
    const m = await segmentMatchSql(num(f.seg));
    where = s`${where} and ${m.q}`;
  }
  const [{ total }] = await s`select count(*)::int as total from contacts c where ${where}`;
  const rows = await s`
    select c.id, c.email, c.first_name, c.last_name, c.practice, c.title, c.status, c.source, c.created_at,
      coalesce((select array_agg(m.list_id) from list_members m where m.contact_id = c.id), '{}') as lists,
      coalesce((select array_agg(t.tag order by t.tag) from contact_tags t where t.contact_id = c.id), '{}') as tags
    from contacts c where ${where} order by c.created_at desc, c.id desc limit ${per} offset ${(page - 1) * per}`;
  const sources = await s`select distinct source from contacts where source <> '' order by 1`;
  return { total, page, per, rows: rows.map(contactOut), sources: sources.map(r => r.source) };
}

function contactOut(c: Row) {
  return {
    id: c.id, email: c.email, first: c.first_name, last: c.last_name, practice: c.practice, title: c.title, phone: c.phone,
    notes: c.notes, custom: c.custom, status: c.status, source: c.source, added: c.created_at,
    lists: (c.lists || []).map(Number), tags: c.tags || [],
  };
}

async function exportContacts(f: Row) {
  const s = sql();
  let where = contactFilter(f);
  if (f.seg) {
    const { segmentMatchSql } = await import("./segment-match");
    where = s`${where} and ${(await segmentMatchSql(num(f.seg))).q}`;
  }
  if (Array.isArray(f.ids) && f.ids.length) where = s`${where} and c.id = any(${f.ids.map(Number)})`;
  const rows = await s`
    select c.email, c.first_name, c.last_name, c.practice, c.title, c.phone, c.status, c.source, c.created_at,
      coalesce((select string_agg(l.name, '; ') from list_members m join lists l on l.id = m.list_id where m.contact_id = c.id), '') as lists,
      coalesce((select string_agg(t.tag, '; ') from contact_tags t where t.contact_id = c.id), '') as tags
    from contacts c where ${where} order by c.email limit 50000`;
  return { rows };
}

async function getContact({ id }: Row) {
  const s = sql();
  const [c] = await s`
    select c.*, coalesce((select array_agg(m.list_id) from list_members m where m.contact_id = c.id), '{}') as lists,
      coalesce((select array_agg(t.tag order by t.tag) from contact_tags t where t.contact_id = c.id), '{}') as tags
    from contacts c where c.id = ${num(id)}`;
  if (!c) fail("Contact not found.");
  const activity = await s`
    select s.campaign_id, cp.name, coalesce(s.sent_at, cp.send_at) as at, s.opened_at is not null as opened, s.clicked_at is not null as clicked, s.status
    from sends s join campaigns cp on cp.id = s.campaign_id where s.contact_id = ${c.id} order by at desc nulls last limit 20`;
  return { ...contactOut(c), activity };
}

async function setTags(tx: any, contactId: number, tags: string[]) {
  await tx`delete from contact_tags where contact_id = ${contactId}`;
  for (const t of [...new Set(tags.map(x => String(x).trim()).filter(Boolean))]) await tx`insert into contact_tags (contact_id, tag) values (${contactId}, ${t}) on conflict do nothing`;
}

async function saveContact({ id, data }: Row) {
  const s = sql();
  const email = String(data.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) fail("That email address doesn’t look right.");
  const newId = await s.begin(async tx => {
    const dup = await tx`select id from contacts where lower(email) = ${email} and id <> ${id ? Number(id) : 0}`;
    if (dup.length) fail("Another contact already has that email.");
    const fields = {
      email, first_name: String(data.first || ""), last_name: String(data.last || ""), practice: String(data.practice || ""),
      title: String(data.title || ""), phone: String(data.phone || ""), notes: String(data.notes || ""), custom: tx.json(data.custom || {}),
    };
    let cid: number;
    if (id) {
      cid = num(id);
      await tx`update contacts set ${tx(fields)}, updated_at = now() where id = ${cid}`;
    } else {
      if (data.consent !== true) fail("Confirm this person asked to receive email from Darkhorse Tech.");
      const [sup] = await tx`select reason from suppressions where email = ${email}`;
      if (sup) fail("That address is on the suppression list (" + sup.reason.replace("_", " ") + ").");
      const [r] = await tx`insert into contacts ${tx({ ...fields, source: "Added manually" })} returning id`;
      cid = r.id;
    }
    if (Array.isArray(data.lists)) {
      await tx`delete from list_members where contact_id = ${cid}`;
      for (const l of data.lists) await tx`insert into list_members (list_id, contact_id) values (${num(l)}, ${cid}) on conflict do nothing`;
    }
    if (Array.isArray(data.tags)) await setTags(tx, cid, data.tags);
    if (data.status && ["subscribed", "unsubscribed", "cleaned"].includes(data.status)) {
      const [cur] = await tx`select status from contacts where id = ${cid}`;
      if (cur.status !== data.status) {
        if (data.status === "subscribed") await tx`delete from suppressions where email = ${email}`;
        else await tx`insert into suppressions (email, reason, source) values (${email}, ${data.status === "cleaned" ? "hard_bounce" : "manual"}, 'Edited by hand') on conflict (email) do nothing`;
        await tx`update contacts set status = ${data.status} where id = ${cid}`;
      }
    }
    return cid;
  });
  return { id: newId };
}

async function bulkContacts({ ids, op, value }: Row) {
  const s = sql();
  const list = (ids as unknown[]).map(Number).filter(Number.isInteger);
  if (!list.length) fail("Select some contacts first.");
  if (op === "tag") {
    const t = String(value || "").trim() || fail("Enter a tag.");
    await s`insert into contact_tags (contact_id, tag) select unnest(${list}::bigint[]), ${t} on conflict do nothing`;
  } else if (op === "untag") {
    await s`delete from contact_tags where contact_id = any(${list}) and tag = ${String(value)}`;
  } else if (op === "addlist") {
    await s`insert into list_members (list_id, contact_id) select ${num(value)}, unnest(${list}::bigint[]) on conflict do nothing`;
  } else if (op === "rmlist") {
    await s`delete from list_members where list_id = ${num(value)} and contact_id = any(${list})`;
  } else if (op === "unsub") {
    await s`insert into suppressions (email, reason, source) select lower(email), 'manual', 'Unsubscribed by hand' from contacts where id = any(${list}) on conflict (email) do nothing`;
    await s`update contacts set status = 'unsubscribed', updated_at = now() where id = any(${list}) and status = 'subscribed'`;
  } else if (op === "delete") {
    await s`delete from contacts where id = any(${list})`;
  } else fail("Unknown action.");
  return { ok: true, n: list.length };
}

/** Import rows already parsed and mapped in the browser. Called in chunks of up to 1000. */
async function importContacts({ rows, listId, newList, tags, status, update, consent, file, method, importId }: Row) {
  if (consent !== true) fail("Confirm these people opted in to Darkhorse Tech email.");
  const s = sql();
  let lid: number;
  if (listId) lid = num(listId);
  else lid = (await createList({ name: newList?.name, senderId: newList?.senderId, reminder: newList?.reminder, description: newList?.description })).id;
  const [list] = await s`select id, name from lists where id = ${lid}`;
  if (!list) fail("Audience not found.");
  const baseTags: string[] = (Array.isArray(tags) ? tags : []).map((t: unknown) => String(t).trim()).filter(Boolean);
  const r = { added: 0, updated: 0, invalid: 0, suppressed: 0, dupes: 0 };
  const seen = new Set<string>();
  const sup = new Set((await s`select email from suppressions where email = any(${(rows as Row[]).map(x => String(x.email || "").trim().toLowerCase())})`).map(x => x.email));
  await s.begin(async tx => {
    for (const o of rows as Row[]) {
      const email = String(o.email || "").trim().toLowerCase();
      if (!EMAIL.test(email)) { r.invalid++; continue; }
      if (seen.has(email)) { r.dupes++; continue; }
      seen.add(email);
      if (sup.has(email) && status !== "unsubscribed") { r.suppressed++; continue; }
      const rowTags = [...baseTags, ...String(o.tags || "").split(/[;|,]/).map(x => x.trim()).filter(Boolean)];
      const custom = o.custom && typeof o.custom === "object" ? o.custom : {};
      const [ex] = await tx`select id from contacts where lower(email) = ${email}`;
      let cid: number;
      if (ex) {
        if (!update) { r.dupes++; continue; }
        cid = ex.id;
        await tx`update contacts set
          first_name = coalesce(nullif(${o.first || ""}, ''), first_name), last_name = coalesce(nullif(${o.last || ""}, ''), last_name),
          practice = coalesce(nullif(${o.practice || ""}, ''), practice), title = coalesce(nullif(${o.title || ""}, ''), title),
          phone = coalesce(nullif(${o.phone || ""}, ''), phone),
          notes = case when ${o.notes || ""} = '' then notes when notes = '' then ${o.notes || ""} else notes || E'\\n' || ${o.notes || ""} end,
          custom = custom || ${tx.json(custom)}, updated_at = now() where id = ${cid}`;
        r.updated++;
      } else {
        const [n] = await tx`insert into contacts (email, first_name, last_name, practice, title, phone, notes, custom, status, source)
          values (${email}, ${o.first || ""}, ${o.last || ""}, ${o.practice || ""}, ${o.title || ""}, ${o.phone || ""}, ${o.notes || ""}, ${tx.json(custom)},
                  ${status === "unsubscribed" ? "unsubscribed" : "subscribed"}, ${file ? "CSV import" : "Pasted list"}) returning id`;
        cid = n.id;
        if (status === "unsubscribed") await tx`insert into suppressions (email, reason, source) values (${email}, 'unsubscribed', 'Imported as unsubscribed') on conflict do nothing`;
        r.added++;
      }
      await tx`insert into list_members (list_id, contact_id) values (${lid}, ${cid}) on conflict do nothing`;
      for (const t of new Set(rowTags)) await tx`insert into contact_tags (contact_id, tag) values (${cid}, ${t}) on conflict do nothing`;
    }
  });
  const skipped = r.invalid + r.suppressed + r.dupes;
  let iid = importId ? Number(importId) : null;
  if (iid) await s`update imports set added = added + ${r.added}, updated = updated + ${r.updated}, skipped = skipped + ${skipped} where id = ${iid}`;
  else [{ id: iid }] = await s`insert into imports (method, file, list_id, list_name, added, updated, skipped) values (${method || (file ? "File upload" : "Pasted list")}, ${file || null}, ${lid}, ${list.name}, ${r.added}, ${r.updated}, ${skipped}) returning id`;
  return { ...r, listId: lid, listName: list.name, importId: iid };
}

/* ---------------- tags ---------------- */
async function renameTag({ from, to }: Row) {
  const t = String(to || "").trim() || fail("Enter a tag name.");
  const s = sql();
  await s`insert into contact_tags (contact_id, tag) select contact_id, ${t} from contact_tags where tag = ${from} on conflict do nothing`;
  await s`delete from contact_tags where tag = ${from}`;
  return { ok: true };
}
async function deleteTag({ tag }: Row) {
  await sql()`delete from contact_tags where tag = ${tag}`;
  return { ok: true };
}
async function tagEmails({ tag, emails }: Row) {
  const t = String(tag || "").trim() || fail("Enter a tag.");
  const list = (emails as unknown[]).map(e => String(e).trim().toLowerCase()).filter(Boolean);
  const r = await sql()`insert into contact_tags (contact_id, tag) select id, ${t} from contacts where lower(email) = any(${list}) on conflict do nothing returning contact_id`;
  const [{ n }] = await sql()`select count(*)::int as n from contacts where lower(email) = any(${list})`;
  return { tagged: n, newlyTagged: r.length, missing: list.length - n };
}

/* ---------------- segments ---------------- */
function cleanConds(conds: unknown): Cond[] {
  return (Array.isArray(conds) ? conds : []).map((c: Row) => ({ f: String(c.f), op: String(c.op), v: String(c.v ?? "") }));
}
async function saveSegment({ id, name, match, conds }: Row) {
  const n = String(name || "").trim() || fail("Give the segment a name.");
  const m = match === "any" ? "any" : "all";
  const cs = sql().json(cleanConds(conds) as any);
  if (id) await sql()`update segments set name = ${n}, match = ${m}, conditions = ${cs} where id = ${num(id)}`;
  else return { id: (await sql()`insert into segments (name, match, conditions) values (${n}, ${m}, ${cs}) returning id`)[0].id };
  return { id };
}
async function deleteSegment({ id }: Row) {
  await sql()`delete from segments where id = ${num(id)}`;
  return { ok: true };
}
async function countSegment({ match, conds }: Row) {
  const { segmentMatchCount } = await import("./segment-match");
  return segmentMatchCount(match === "any" ? "any" : "all", cleanConds(conds));
}

/* ---------------- suppression ---------------- */
async function suppressEmails({ emails, reason }: Row) {
  const s = sql();
  const list = [...new Set((emails as unknown[]).map(e => String(e).trim().toLowerCase()).filter(e => EMAIL.test(e)))];
  const why = /bounce/i.test(reason) ? "hard_bounce" : "unsubscribed";
  for (const e of list) await s`insert into suppressions (email, reason, source) values (${e}, ${why}, ${String(reason || "Manual")}) on conflict (email) do nothing`;
  await s`update contacts set status = ${why === "hard_bounce" ? "cleaned" : "unsubscribed"}, updated_at = now() where lower(email) = any(${list}) and status = 'subscribed'`;
  return { n: list.length, invalid: (emails as unknown[]).length - list.length };
}
async function unsuppress({ email }: Row) {
  const e = String(email).toLowerCase();
  await sql()`delete from suppressions where email = ${e}`;
  await sql()`update contacts set status = 'subscribed', updated_at = now() where lower(email) = ${e}`;
  return { ok: true };
}

/* ---------------- templates ---------------- */
async function saveTemplate({ id, name, html }: Row) {
  const n = String(name || "Untitled template").slice(0, 200);
  if (id) {
    await sql()`update templates set name = ${n}, html = ${html ?? ""}, updated_at = now() where id = ${num(id)}`;
    return { id };
  }
  const [t] = await sql()`insert into templates (name, html) values (${n}, ${html ?? ""}) returning id`;
  return { id: t.id };
}
async function renameTemplate({ id, name }: Row) {
  await sql()`update templates set name = ${String(name).slice(0, 200)}, updated_at = now() where id = ${num(id)}`;
  return { ok: true };
}
async function deleteTemplate({ id }: Row) {
  await sql()`delete from templates where id = ${num(id)}`;
  return { ok: true };
}

/* ---------------- senders ---------------- */
async function saveSender({ id, name, email, replyTo }: Row) {
  const e = String(email || "").trim().toLowerCase();
  if (!String(name || "").trim()) fail("Enter a From name.");
  if (!EMAIL.test(e) || !e.endsWith("@darkhorsetech.com")) fail("Use an @darkhorsetech.com address. That’s the domain verified in Amazon SES.");
  const r = String(replyTo || "").trim().toLowerCase() || e;
  if (!EMAIL.test(r)) fail("Check the reply-to address.");
  try {
    if (id) await sql()`update senders set name = ${name}, email = ${e}, reply_to = ${r} where id = ${num(id)}`;
    else return { id: (await sql()`insert into senders (name, email, reply_to) values (${name}, ${e}, ${r}) returning id`)[0].id };
  } catch (err: any) {
    if (err?.code === "23505") fail("That sender already exists.");
    throw err;
  }
  return { id };
}
async function defaultSender({ id }: Row) {
  await sql().begin(async tx => {
    await tx`update senders set is_default = false`;
    await tx`update senders set is_default = true where id = ${num(id)}`;
  });
  return { ok: true };
}
async function deleteSender({ id }: Row) {
  const sid = num(id);
  const [d] = await sql()`select is_default from senders where id = ${sid}`;
  if (d?.is_default) fail("Make another sender the default first.");
  const [def] = await sql()`select id from senders where is_default limit 1`;
  await sql()`update campaigns set sender_id = ${def?.id ?? null} where sender_id = ${sid} and status in ('draft','scheduled')`;
  await sql()`delete from senders where id = ${sid}`;
  return { ok: true };
}

/* ---------------- settings, images ---------------- */
async function saveSettings({ patch }: Row) {
  const map: Row = { company: "company", footerAddress: "footer_address", reminder: "default_reminder", trackOpens: "track_opens", trackClicks: "track_clicks", requirePermission: "require_permission", fields: "custom_fields", maxPerCampaign: "max_per_campaign", maxPerDay: "max_per_day", sendRate: "send_rate" };
  for (const [k, v] of Object.entries(patch || {})) {
    const key = map[k];
    if (!key || !(SETTING_KEYS as readonly string[]).includes(key)) continue;
    if (key === "footer_address" && !String(v).trim()) fail("A mailing address is required by law in every marketing email.");
    if (key === "max_per_campaign" || key === "max_per_day") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 50000) fail("Limits must be whole numbers between 1 and 50,000.");
    }
    if (key === "send_rate") {
      const n = Number(v);
      if (!(n >= 1 && n <= 13)) fail("Sending speed must be between 1 and 13 emails per second (Amazon’s limit is 14).");
    }
    await sql()`insert into settings (key, value) values (${key}, ${sql().json(v as any)}) on conflict (key) do update set value = excluded.value`;
  }
  return { ok: true };
}
async function saveImage({ id, name, url }: Row) {
  const u = String(url || "").trim();
  if (!/^https:\/\/\S+$/i.test(u)) fail("Paste the full image link, starting with https://");
  const n = String(name || "").trim() || u.split("/").pop()!.split("?")[0].slice(0, 120) || "image";
  try {
    if (id) await sql()`update images set name = ${n}, url = ${u} where id = ${num(id)}`;
    else return { id: (await sql()`insert into images (name, url) values (${n}, ${u}) returning id`)[0].id };
  } catch (e: any) {
    if (e?.code === "23505") fail("That image link is already saved.");
    throw e;
  }
  return { id };
}
async function deleteImage({ id }: Row) {
  await sql()`delete from images where id = ${num(id)}`;
  return { ok: true };
}

async function deliverability() {
  const st = await settings();
  const feed = await feedStatus();
  return { feed, linkHost: new URL(baseUrl()).host, limits: { maxPerCampaign: st.maxPerCampaign, maxPerDay: st.maxPerDay, sendRate: st.sendRate } };
}
async function connectFeed() {
  try {
    await connectFeedAws();
  } catch (e) {
    const m = (e as Error).message || String(e);
    if (/not authorized|AccessDenied/i.test(m)) fail("Amazon refused: the app’s AWS key isn’t allowed to set this up. " + m);
    if (/security token|InvalidClientTokenId|credential/i.test(m)) fail("The AWS access key in Vercel isn’t working: " + m);
    fail("Couldn’t set up the feed: " + m);
  }
  // Amazon confirms the subscription within a few seconds by calling PaunchPost back.
  for (let i = 0; i < 8; i++) {
    const f = await feedStatus();
    if (f.state === "on") break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return deliverability();
}
async function resumeCampaign({ id }: Row) {
  const r = await sql()`update campaigns set paused_reason = null, resumed_at = now(), updated_at = now() where id = ${num(id)} and status = 'sending' and paused_reason is not null returning id`;
  if (!r.length) fail("That campaign isn’t paused.");
  kickWorker();
  return { ok: true };
}
async function stopCampaign({ id }: Row) {
  const cid = num(id);
  const s = sql();
  await s`update sends set status = 'skipped', error = 'Stopped before sending', claimed_at = null where campaign_id = ${cid} and status = 'queued'`;
  await s`update campaigns set paused_reason = null, status = 'sent', finished_at = now(), updated_at = now() where id = ${cid} and status = 'sending'`;
  return { ok: true };
}
async function spamCheck({ id }: Row) {
  const [c] = await sql()`select subject, preview, html from campaigns where id = ${num(id)}`;
  if (!c) fail("Campaign not found.");
  const problems = await readiness(num(id));
  return { problems, warnings: lint(c as any, { linkHost: new URL(baseUrl()).host }) };
}

export const ACTIONS: Record<string, (args: Row) => Promise<unknown>> = {
  deliverability,
  connectFeed,
  resumeCampaign,
  stopCampaign,
  spamCheck,
  getCampaign, createCampaign, updateCampaign, deleteCampaigns, unschedule, countAudience, send, test, report,
  createList, updateList, deleteList,
  contacts, exportContacts, getContact, saveContact, bulkContacts, importContacts,
  renameTag, deleteTag, tagEmails,
  saveSegment, deleteSegment, countSegment,
  suppressEmails, unsuppress,
  saveTemplate, renameTemplate, deleteTemplate,
  saveSender, defaultSender, deleteSender,
  saveSettings, saveImage, deleteImage,
  footerCheck: async () => ({ footer: await getSetting("footer_address", "") }),
};
