import { NextResponse } from "next/server";
import { ACTIONS, ActionError } from "@/lib/server/actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { action: "createCampaign", ...args } — every change the interface makes goes through here. */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const fn = ACTIONS[String(body.action)];
  if (!fn) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  try {
    return NextResponse.json((await fn(body)) ?? { ok: true });
  } catch (e) {
    if (e instanceof ActionError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("rpc", body.action, e);
    return NextResponse.json({ error: "Something went wrong: " + (e as Error).message }, { status: 500 });
  }
}
