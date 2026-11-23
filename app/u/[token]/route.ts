import { unsubscribeToken, emailForToken } from "@/lib/server/unsubscribe";
import { getSetting } from "@/lib/server/db";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string) {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f5f4f9;font-family:Arial,Helvetica,sans-serif;color:#1f1a33}.c{max-width:460px;margin:12vh auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 2px 12px rgba(28,19,64,.08);text-align:center}h1{font-size:22px;color:#2b1e5c;margin:0 0 12px}p{line-height:1.6;color:#4b4563}button{background:#2b1e5c;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;font-weight:bold;cursor:pointer}</style></head>
<body><div class="c">${body}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

function mask(email: string) {
  const [u, d] = email.split("@");
  return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.min(6, u.length - 2))) + "@" + d;
}

/**
 * GET shows a confirm button. It never unsubscribes by itself, because email security
 * scanners open links automatically.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const company = String(await getSetting("company", "Darkhorse Tech"));
  if (token === "test") return page("Test email", `<h1>This was a test email</h1><p>Unsubscribe links work in real campaigns.</p>`);
  const info = await emailForToken(token);
  if (!info) return page("Link expired", `<h1>This link has expired</h1><p>To stop getting emails from ${esc(company)}, reply to any of our emails and ask to be removed.</p>`);
  if (info.unsubscribed) return page("Unsubscribed", `<h1>You’re unsubscribed</h1><p>${esc(mask(info.email))} won’t get any more marketing emails from ${esc(company)}.</p>`);
  return page(
    "Unsubscribe",
    `<h1>Unsubscribe?</h1><p>Stop marketing emails from ${esc(company)} to <b>${esc(mask(info.email))}</b>.</p><form method="post"><button type="submit">Unsubscribe</button></form>`
  );
}

/** One-click unsubscribe (Gmail/Yahoo "List-Unsubscribe-Post") and the confirm button both land here. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const company = String(await getSetting("company", "Darkhorse Tech"));
  const body = await req.text().catch(() => "");
  const oneClick = /List-Unsubscribe=One-Click/i.test(body);
  const email = await unsubscribeToken(token, oneClick ? "one-click" : "unsubscribe page");
  if (oneClick) return new Response(email ? "OK" : "Unknown", { status: email ? 200 : 404 });
  if (!email) return page("Link expired", `<h1>This link has expired</h1>`);
  return page("Unsubscribed", `<h1>You’re unsubscribed</h1><p>${esc(mask(email))} won’t get any more marketing emails from ${esc(company)}. Sorry to see you go.</p>`);
}
