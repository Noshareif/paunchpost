import { db } from "./db";

// Who a campaign goes to. Mirrors the "To" step of the campaign builder.
export type Cond = { f: string; op: string; v: string };
export type Audience = {
  listIds?: number[];
  tags?: string[];
  segmentIds?: number[];
  exclude?: { listIds?: number[]; tags?: string[]; segmentIds?: number[] };
  nonOpenersOf?: number | null;
};

// A SQL fragment. Never `await` one directly: postgres.js would run it as a query.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frag = any;
type Boxed = { q: Frag };

const TEXT_FIELDS: Record<string, string> = {
  email: "c.email",
  first: "c.first_name",
  last: "c.last_name",
  practice: "c.practice",
  title: "c.title",
  source: "c.source",
};

/** One segment condition as a SQL fragment about contact `c`. Unknown conditions match nobody. */
function condSql(k: Cond): Frag {
  const sql = db();
  const v = String(k.v ?? "");
  if (TEXT_FIELDS[k.f]) {
    const col = sql(TEXT_FIELDS[k.f]); // identifier from a fixed whitelist, escaped as "c"."email"
    if (k.op === "contains") return sql`${col} ilike ${"%" + v + "%"}`;
    if (k.op === "not") return sql`${col} not ilike ${"%" + v + "%"}`;
    if (k.op === "is") return sql`lower(${col}) = lower(${v})`;
    if (k.op === "isnt") return sql`lower(${col}) <> lower(${v})`;
  }
  switch (k.f) {
    case "list":
      return k.op === "notin"
        ? sql`not exists (select 1 from list_members m where m.contact_id = c.id and m.list_id = ${Number(v)})`
        : sql`exists (select 1 from list_members m where m.contact_id = c.id and m.list_id = ${Number(v)})`;
    case "tag":
      return k.op === "hasnt"
        ? sql`not exists (select 1 from contact_tags t where t.contact_id = c.id and t.tag = ${v})`
        : sql`exists (select 1 from contact_tags t where t.contact_id = c.id and t.tag = ${v})`;
    case "status":
      return k.op === "isnt" ? sql`c.status <> ${v}` : sql`c.status = ${v}`;
    case "added":
      return k.op === "before" ? sql`c.created_at < ${v}::date` : sql`c.created_at > ${v}::date`;
    case "activity": {
      const camp = Number(v);
      const sent = sql`s.contact_id = c.id and s.campaign_id = ${camp} and s.status in ('sent','bounced','complained')`;
      if (k.op === "sent") return sql`exists (select 1 from sends s where ${sent})`;
      if (k.op === "opened") return sql`exists (select 1 from sends s where ${sent} and s.opened_at is not null)`;
      if (k.op === "notopened") return sql`exists (select 1 from sends s where ${sent} and s.opened_at is null)`;
      if (k.op === "clicked") return sql`exists (select 1 from sends s where ${sent} and s.clicked_at is not null)`;
      if (k.op === "notclicked") return sql`exists (select 1 from sends s where ${sent} and s.clicked_at is null)`;
      break;
    }
    case "engagement": {
      const active = sql`exists (select 1 from sends s where s.contact_id = c.id and s.opened_at > now() - interval '90 days')`;
      return v === "inactive" ? sql`not ${active}` : active;
    }
  }
  return sql`false`;
}

function joinAll(frags: Frag[], op: "and" | "or"): Frag {
  const sql = db();
  if (!frags.length) return op === "and" ? sql`true` : sql`false`;
  return frags.slice(1).reduce<Frag>((acc, f) => (op === "and" ? sql`${acc} and (${f})` : sql`${acc} or (${f})`), sql`(${frags[0]})`);
}

async function segmentSql(ids: number[]): Promise<Boxed[]> {
  if (!ids.length) return [];
  const sql = db();
  const segs = await sql`select match, conditions from segments where id = any(${ids})`;
  return segs.map(s => ({ q: joinAll((s.conditions as Cond[]).map(condSql), s.match === "any" ? "or" : "and") }));
}

/** Contacts matching (any list / tag / segment) and none of the exclusions, as a SQL fragment about `c`. */
async function matchSql(a: Audience): Promise<Boxed> {
  const sql = db();
  const inc: Frag[] = [];
  if (a.listIds?.length) inc.push(sql`exists (select 1 from list_members m where m.contact_id = c.id and m.list_id = any(${a.listIds}))`);
  if (a.tags?.length) inc.push(sql`exists (select 1 from contact_tags t where t.contact_id = c.id and t.tag = any(${a.tags}))`);
  inc.push(...(await segmentSql(a.segmentIds ?? [])).map(b => b.q));
  if (a.nonOpenersOf) {
    inc.length = 0; // a resend goes only to the original campaign's non-openers
    inc.push(sql`exists (select 1 from sends s where s.contact_id = c.id and s.campaign_id = ${a.nonOpenersOf} and s.status = 'sent' and s.opened_at is null)`);
  }
  const ex: Frag[] = [];
  const e = a.exclude ?? {};
  if (e.listIds?.length) ex.push(sql`exists (select 1 from list_members m where m.contact_id = c.id and m.list_id = any(${e.listIds}))`);
  if (e.tags?.length) ex.push(sql`exists (select 1 from contact_tags t where t.contact_id = c.id and t.tag = any(${e.tags}))`);
  ex.push(...(await segmentSql(e.segmentIds ?? [])).map(b => b.q));
  return { q: sql`(${joinAll(inc, "or")}) and not (${joinAll(ex, "or")})` };
}

/** Everyone who would actually get the email: subscribed and not on the suppression list. */
export async function recipientsSql(a: Audience): Promise<Boxed> {
  const sql = db();
  const m = await matchSql(a);
  return {
    q: sql`
    select c.id, c.email from contacts c
    where c.status = 'subscribed'
      and ${m.q}
      and not exists (select 1 from suppressions x where x.email = lower(c.email))`,
  };
}

export async function countRecipients(a: Audience): Promise<number> {
  const sql = db();
  const inner = await recipientsSql(a);
  const [{ n }] = await sql`select count(*)::int as n from (${inner.q}) r`;
  return n;
}
