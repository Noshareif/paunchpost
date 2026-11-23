import { db } from "./db";

/** Unsubscribes the person behind a send token. Returns their email, or null if the token is unknown. */
export async function unsubscribeToken(token: string, how: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const sql = db();
  const [s] = await sql`select id, email, contact_id, campaign_id from sends where token = ${token}`;
  if (!s) return null;
  await sql.begin(async tx => {
    await tx`update sends set unsubscribed_at = coalesce(unsubscribed_at, now()) where id = ${s.id}`;
    await tx`insert into suppressions (email, reason, source) values (${s.email}, 'unsubscribed', ${how + " · campaign " + s.campaign_id}) on conflict (email) do nothing`;
    await tx`update contacts set status = 'unsubscribed', updated_at = now() where lower(email) = ${s.email} and status = 'subscribed'`;
  });
  return s.email as string;
}

export async function emailForToken(token: string): Promise<{ email: string; unsubscribed: boolean } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const [s] = await db()`select s.email, (x.email is not null) as unsubscribed from sends s left join suppressions x on x.email = s.email where s.token = ${token}`;
  return s ? { email: s.email, unsubscribed: s.unsubscribed } : null;
}
