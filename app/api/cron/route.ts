import { NextResponse } from "next/server";
import { authorized, tick } from "@/lib/server/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Hit every few minutes by an outside scheduler (and once a day by Vercel Cron as a backup).
 * Starts scheduled campaigns when their time comes and keeps any big send moving.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return new NextResponse("Forbidden", { status: 403 });
  return NextResponse.json(await tick());
}
