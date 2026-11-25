import { NextResponse } from "next/server";
import { heartbeat } from "@/lib/server/worker";

export const dynamic = "force-dynamic";

/** Public heartbeat, called every few minutes by GitHub Actions. See heartbeat() for why it's safe. */
export async function GET() {
  return NextResponse.json(await heartbeat());
}
export const POST = GET;
