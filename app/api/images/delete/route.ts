import { NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3, config } from "@/lib/s3";
import { isOurKey } from "@/lib/images";

export const dynamic = "force-dynamic";

/** POST /api/images/delete  { key } — removes one image from the library. */
export async function POST(req: Request) {
  let key: unknown;
  try {
    ({ key } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!isOurKey(key)) {
    return NextResponse.json({ error: "That isn’t a PaunchPost image." }, { status: 400 });
  }
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete failed", err);
    return NextResponse.json({ error: "Couldn’t delete the image." }, { status: 500 });
  }
}
