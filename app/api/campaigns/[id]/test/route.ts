import { NextResponse } from "next/server";
import { sendTest, SendError } from "@/lib/server/send";

export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** POST { to: ["noah@darkhorsetech.com"], contactId? } — up to 5 test emails. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({}));
  const to: string[] = Array.isArray(body.to) ? body.to.map((s: unknown) => String(s).trim()).filter(Boolean) : [];
  if (!to.length || to.length > 5 || to.some(e => !EMAIL.test(e))) return NextResponse.json({ error: "Enter up to 5 valid email addresses." }, { status: 400 });
  try {
    await sendTest(id, to, body.contactId ? Number(body.contactId) : undefined);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SendError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "Amazon SES didn’t accept the test email: " + (e as Error).message }, { status: 502 });
  }
}
