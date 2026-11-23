import { NextResponse } from "next/server";
import { authorized, tick } from "@/lib/server/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sends the next batch. Called by the app itself while a campaign is going out. */
export async function POST(req: Request) {
  if (!authorized(req)) return new NextResponse("Forbidden", { status: 403 });
  return NextResponse.json(await tick());
}
