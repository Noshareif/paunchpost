import { NextResponse } from "next/server";
import { migrate, importMailchimp } from "@/lib/server/setup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The "Set up database" button on the Status page (behind the PaunchPost sign-in). */
export async function POST(req: Request) {
  try {
    await migrate();
    const r = await importMailchimp();
    return NextResponse.redirect(new URL("/status?setup=" + r.campaigns, req.url), 303);
  } catch (e) {
    console.error("setup failed", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
