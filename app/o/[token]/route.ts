import { db } from "@/lib/server/db";

export const dynamic = "force-dynamic";

// 1x1 transparent GIF
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** Open tracking pixel: /o/<token> */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (/^[a-f0-9]{64}$/.test(token)) {
    try {
      await db()`update sends set open_count = open_count + 1, opened_at = coalesce(opened_at, now()) where token = ${token}`;
    } catch (e) {
      console.error("open tracking failed", e);
    }
  }
  return new Response(GIF, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private", "Content-Length": String(GIF.length) },
  });
}
