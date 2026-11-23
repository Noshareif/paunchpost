import { NextResponse } from "next/server";
import { startCampaign, SendError } from "@/lib/server/send";
import { kickWorker } from "@/lib/server/worker";
import { db } from "@/lib/server/db";

export const dynamic = "force-dynamic";

/**
 * POST { confirm: true, sendAt?: ISO } — send now, or schedule for later.
 * `confirm` is the "everyone on this list asked to hear from us" box.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== true) return NextResponse.json({ error: "Confirm that everyone on this list asked to hear from Darkhorse Tech." }, { status: 400 });
  try {
    if (body.sendAt) {
      const when = new Date(body.sendAt);
      if (isNaN(+when) || +when < Date.now() + 60_000) return NextResponse.json({ error: "Pick a time at least a minute from now." }, { status: 400 });
      const rows = await db()`update campaigns set status = 'scheduled', send_at = ${when}, updated_at = now() where id = ${id} and status in ('draft','scheduled') returning id`;
      if (!rows.length) return NextResponse.json({ error: "Only drafts can be scheduled." }, { status: 400 });
      return NextResponse.json({ scheduled: when.toISOString() });
    }
    const r = await startCampaign(id);
    kickWorker();
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof SendError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "Something went wrong starting the send." }, { status: 500 });
  }
}
