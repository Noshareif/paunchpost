import { db } from "./db";
import { condSql, joinAll, type Cond } from "./audience";

/** A saved segment as a SQL condition about contact `c` (boxed so it isn't run on await). */
export async function segmentMatchSql(segmentId: number) {
  const sql = db();
  const [g] = await sql`select match, conditions from segments where id = ${segmentId}`;
  if (!g) return { q: sql`false` };
  return { q: joinAll((g.conditions as Cond[]).map(condSql), g.match === "any" ? "or" : "and") };
}

/** Live count while building a segment. */
export async function segmentMatchCount(match: "all" | "any", conds: Cond[]) {
  const sql = db();
  const m = joinAll(conds.map(condSql), match === "any" ? "or" : "and");
  const [r] = await sql`
    select count(*)::int as n,
      count(*) filter (where c.status = 'subscribed' and not exists (select 1 from suppressions x where x.email = lower(c.email)))::int as subs
    from contacts c where ${m}`;
  return r;
}
