import { db, getSetting } from "@/lib/server/db";
import { renderHtml, type Person } from "@/lib/server/render";
import { baseUrl } from "@/lib/server/send";

export const dynamic = "force-dynamic";

/** "View in browser": the recipient's own copy of the email. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response("Not found", { status: 404 });
  const sql = db();
  const [s] = await sql`
    select s.token, s.email, c.html, c.preview, ct.first_name, ct.last_name, ct.practice, ct.title, ct.phone, ct.custom,
      (select l.reminder from lists l where l.id = any(coalesce((select array_agg(x::int) from jsonb_array_elements_text(c.audience->'listIds') x), '{}')) and l.reminder is not null limit 1) as reminder
    from sends s join campaigns c on c.id = s.campaign_id left join contacts ct on ct.id = s.contact_id
    where s.token = ${token}`;
  if (!s) return new Response("This email is no longer available.", { status: 404 });
  const html = renderHtml(s.html, s as unknown as Person, {
    baseUrl: baseUrl(),
    token,
    company: String(await getSetting("company", "Darkhorse Tech")),
    footerAddress: String(await getSetting("footer_address", "")),
    reminder: s.reminder || String(await getSetting("default_reminder", "")),
    trackOpens: false,
    trackClicks: false,
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
