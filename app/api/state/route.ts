import { NextResponse } from "next/server";
import { getState } from "@/lib/server/actions";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getState());
  } catch (e) {
    console.error("state failed", e);
    return NextResponse.json({ error: (e as Error).message, needsSetup: /does not exist/.test((e as Error).message) }, { status: 500 });
  }
}
