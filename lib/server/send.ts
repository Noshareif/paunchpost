import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { db, getSetting } from "./db";
import { recipientsSql, type Audience } from "./audience";
import { renderHtml, renderSubject, renderText, extractLinks, unsubscribeUrl, type Person } from "./render";

export function baseUrl(): string {
  const u = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
  return u.replace(/\/+$/, "");
}

let ses: SESv2Client | null = null;
function client() {
  if (!ses) {
    ses = new SESv2Client({
      region: process.env.SES_REGION || process.env.AWS_REGION || "us-east-2",
      ...(process.env.SES_ENDPOINT ? { endpoint: process.env.SES_ENDPOINT } : {}),
    });
  }
  return ses;
}

const RATE = Number(process.env.SES_RATE_PER_SECOND || 12); // stay under SES's 14/second limit
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Shared = { company: string; footerAddress: string; defaultReminder: string };
async function shared(): Promise<Shared> {
  const [company, footerAddress, defaultReminder] = await Promise.all([
    getSetting("company", "Darkhorse Tech"),
    getSetting("footer_address", ""),
    getSetting("default_reminder", "You’re receiving this email because you opted in to receiving our emails."),
  ]);
  return { company: String(company), footerAddress: String(footerAddress), defaultReminder: String(defaultReminder) };
}

function fromLine(s: { name: string; email: string }) {
  return `"${s.name.replace(/"/g, "'")}" <${s.email}>`;
}

async function sesSend(opts: { from: string; replyTo?: string | null; to: string; subject: string; html: string; text: string; unsub?: string }) {
  const headers = opts.unsub
    ? [
        { Name: "List-Unsubscribe", Value: `<${opts.unsub}>` },
        { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      ]
    : [];
  const out = await client().send(
    new SendEmailCommand({
      FromEmailAddress: opts.from,
      ReplyToAddresses: opts.replyTo ? [opts.replyTo] : undefined,
      Destination: { ToAddresses: [opts.to] },
      ConfigurationSetName: process.env.SES_CONFIGURATION_SET || undefined,
      Content: {
        Simple: {
          Subject: { Data: opts.subject, Charset: "UTF-8" },
          Body: { Html: { Data: opts.html, Charset: "UTF-8" }, Text: { Data: opts.text, Charset: "UTF-8" } },
          Headers: headers.length ? headers : undefined,
        },
      },
    })
  );
  return out.MessageId || null;
}

export class SendError extends Error {}

/** Checks a draft can go out. Returns the problems in plain words (empty = ready). */
export async function readiness(campaignId: number): Promise<string[]> {
  const sql = db();
  const [c] = await sql`select c.*, s.email as sender_email from campaigns c left join senders s on s.id = c.sender_id where c.id = ${campaignId}`;
  if (!c) return ["Campaign not found."];
  const p: string[] = [];
  if (!["draft", "scheduled"].includes(c.status)) p.push(`It’s already ${c.status}.`);
  if (!c.subject.trim()) p.push("Add a subject line.");
  if (!c.html.trim()) p.push("Add the email content.");
  if (!c.sender_email) p.push("Choose who it’s from.");
  const footer = await getSetting("footer_address", "");
  if (!String(footer).trim()) p.push("Add the mailing address for the footer in Settings.");
  return p;
}

/** Locks in the recipient list and starts sending. Recipients are fixed at this moment. */
export async function startCampaign(campaignId: number): Promise<{ queued: number }> {
  const problems = await readiness(campaignId);
  if (problems.length) throw new SendError(problems.join(" "));
  const sql = db();
  return sql.begin(async tx => {
    const [c] = await tx`select * from campaigns where id = ${campaignId} for update`;
    if (!["draft", "scheduled"].includes(c.status)) throw new SendError(`It’s already ${c.status}.`);
    const rec = await recipientsSql(c.audience as Audience);
    const inserted = await tx`
      insert into sends (campaign_id, contact_id, email, token)
      select ${campaignId}, r.id, lower(r.email), replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
      from (${rec.q}) r
      on conflict (campaign_id, email) do nothing
      returning id`;
    if (!inserted.length) throw new SendError("Nobody to send to: the chosen audiences have no subscribed contacts.");
    for (const url of extractLinks(c.html)) {
      await tx`insert into links (campaign_id, url) values (${campaignId}, ${url}) on conflict do nothing`;
    }
    await tx`update campaigns set status = 'sending', started_at = now(), send_at = coalesce(case when status = 'scheduled' then send_at end, now()), updated_at = now() where id = ${campaignId}`;
    return { queued: inserted.length };
  });
}

/**
 * Sends the next batch of queued emails (any campaign). Call repeatedly until it returns remaining = 0.
 * Safe to run in parallel: rows are claimed with SKIP LOCKED.
 */
export async function processBatch(opts: { limit?: number; deadlineMs?: number } = {}) {
  const sql = db();
  const limit = opts.limit ?? 200;
  const deadline = Date.now() + (opts.deadlineMs ?? 45_000);
  // Rows a crashed worker left half-done go back in the queue.
  await sql`update sends set status = 'queued', claimed_at = null where status = 'sending' and claimed_at < now() - interval '10 minutes'`;
  const rows = await sql`
    update sends set status = 'sending', claimed_at = now()
    where id in (select id from sends where status = 'queued' order by campaign_id, id limit ${limit} for update skip locked)
    returning id, campaign_id, contact_id, email, token`;
  if (!rows.length) return { sent: 0, failed: 0, remaining: 0 };

  const sh = await shared();
  const campaigns = new Map<number, any>();
  const links = new Map<number, Map<string, number>>();
  for (const cid of new Set(rows.map(r => r.campaign_id as number))) {
    const [c] = await sql`
      select c.*, s.name as sender_name, s.email as sender_email, s.reply_to,
        (select l.reminder from lists l where l.id = any(coalesce((select array_agg(x::int) from jsonb_array_elements_text(c.audience->'listIds') x), '{}')) and l.reminder is not null limit 1) as reminder
      from campaigns c left join senders s on s.id = c.sender_id where c.id = ${cid}`;
    campaigns.set(cid, c);
    const ls = await sql`select id, url from links where campaign_id = ${cid}`;
    links.set(cid, new Map(ls.map(l => [l.url as string, l.id as number])));
  }
  const contactIds = rows.map(r => r.contact_id).filter(Boolean);
  const people = new Map<number, Person>();
  if (contactIds.length) {
    for (const p of await sql`select id, email, first_name, last_name, practice, title, phone, custom from contacts where id = any(${contactIds})`) people.set(Number(p.id), p as unknown as Person);
  }
  const suppressed = new Set((await sql`select email from suppressions where email = any(${rows.map(r => r.email)})`).map(r => r.email));

  let sent = 0, failed = 0, i = 0;
  const gap = 1000 / RATE;
  const worker = async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const started = Date.now();
      if (Date.now() > deadline) {
        await sql`update sends set status = 'queued', claimed_at = null where id = ${r.id}`;
        continue;
      }
      if (suppressed.has(r.email)) {
        await sql`update sends set status = 'skipped', error = 'On the suppression list' where id = ${r.id}`;
        continue;
      }
      const c = campaigns.get(r.campaign_id);
      const person: Person = people.get(Number(r.contact_id)) || { email: r.email };
      const o = {
        baseUrl: baseUrl(),
        token: r.token,
        company: sh.company,
        footerAddress: sh.footerAddress,
        reminder: c.reminder || sh.defaultReminder,
        preview: c.preview,
        trackOpens: c.track_opens,
        trackClicks: c.track_clicks,
        linkId: (u: string) => links.get(r.campaign_id)!.get(u),
      };
      try {
        const id = await sesSend({
          from: fromLine({ name: c.sender_name, email: c.sender_email }),
          replyTo: c.reply_to,
          to: r.email,
          subject: renderSubject(c.subject, person),
          html: renderHtml(c.html, person, o),
          text: renderText(c.html, c.plain, person, o),
          unsub: unsubscribeUrl(o.baseUrl, r.token),
        });
        await sql`update sends set status = 'sent', ses_message_id = ${id}, sent_at = now(), error = null where id = ${r.id}`;
        sent++;
      } catch (e: any) {
        const throttled = /Throttl|Rate exceeded|TooManyRequests|MaxSendRate/i.test(String(e?.name) + String(e?.message));
        if (throttled) {
          await sql`update sends set status = 'queued', claimed_at = null where id = ${r.id}`;
          await sleep(1000);
        } else {
          await sql`update sends set status = 'failed', error = ${String(e?.message || e).slice(0, 500)} where id = ${r.id}`;
          failed++;
        }
      }
      const wait = gap * 4 - (Date.now() - started); // 4 workers share the rate
      if (wait > 0) await sleep(wait);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Campaigns with nothing left in the queue are done.
  await sql`
    update campaigns c set status = 'sent', finished_at = now(), updated_at = now()
    where c.status = 'sending' and c.id = any(${[...campaigns.keys()]})
      and not exists (select 1 from sends s where s.campaign_id = c.id and s.status in ('queued','sending'))`;
  const [{ n }] = await sql`select count(*)::int as n from sends where status in ('queued','sending')`;
  return { sent, failed, remaining: n };
}

/** Starts any scheduled campaign whose time has come. */
export async function startDueCampaigns() {
  const sql = db();
  const due = await sql`select id from campaigns where status = 'scheduled' and send_at <= now() order by send_at`;
  const results: { id: number; ok: boolean; message?: string }[] = [];
  for (const { id } of due) {
    try {
      await startCampaign(id);
      results.push({ id, ok: true });
    } catch (e: any) {
      // Leave it visible as a draft with the reason, rather than retrying forever.
      await sql`update campaigns set status = 'draft', updated_at = now() where id = ${id}`;
      results.push({ id, ok: false, message: String(e?.message || e) });
    }
  }
  return results;
}

/** Test emails: no tracking, a clearly marked subject, merge tags filled from a sample contact. */
export async function sendTest(campaignId: number, to: string[], sampleContactId?: number) {
  const sql = db();
  const [c] = await sql`select c.*, s.name as sender_name, s.email as sender_email, s.reply_to from campaigns c left join senders s on s.id = c.sender_id where c.id = ${campaignId}`;
  if (!c) throw new SendError("Campaign not found.");
  if (!c.sender_email) throw new SendError("Choose who it’s from first.");
  const [p] = sampleContactId
    ? await sql`select * from contacts where id = ${sampleContactId}`
    : await sql`select * from contacts where status = 'subscribed' order by id limit 1`;
  const person: Person = p ? (p as unknown as Person) : { email: to[0], first_name: "Noah", practice: "Sample Dental" };
  const sh = await shared();
  const o = { baseUrl: baseUrl(), token: "test", company: sh.company, footerAddress: sh.footerAddress, reminder: sh.defaultReminder, preview: c.preview, trackOpens: false, trackClicks: false };
  for (const addr of to) {
    await sesSend({
      from: fromLine({ name: c.sender_name, email: c.sender_email }),
      replyTo: c.reply_to,
      to: addr,
      subject: "[Test] " + renderSubject(c.subject || c.name, person),
      html: renderHtml(c.html, person, o),
      text: renderText(c.html, c.plain, person, o),
    });
  }
}
