import { db } from "@/lib/server/db";
import { baseUrl } from "@/lib/server/send";

export const dynamic = "force-dynamic";

/** Click tracking: /r/<token>/<linkId> records the click, then forwards to the real link. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; link: string }> }) {
  const { token, link } = await ctx.params;
  const linkId = Number(link);
  if (!/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(linkId)) return Response.redirect(baseUrl(), 302);
  const sql = db();
  // The link must belong to the same campaign as this recipient, so the redirect can't be pointed anywhere else.
  const [row] = await sql`
    select s.id as send_id, l.id as link_id, l.url
    from sends s join links l on l.campaign_id = s.campaign_id and l.id = ${linkId}
    where s.token = ${token}`;
  if (!row) return new Response("This link has expired.", { status: 404 });
  try {
    await sql`insert into clicks (send_id, link_id) values (${row.send_id}, ${row.link_id})`;
    // A click proves the email was opened, even if images were blocked.
    await sql`update sends set click_count = click_count + 1, clicked_at = coalesce(clicked_at, now()), opened_at = coalesce(opened_at, now()), open_count = greatest(open_count, 1) where id = ${row.send_id}`;
  } catch (e) {
    console.error("click tracking failed", e);
  }
  return new Response(null, { status: 302, headers: { Location: row.url, "Cache-Control": "no-store" } });
}
