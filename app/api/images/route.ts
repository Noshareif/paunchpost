import { NextResponse } from "next/server";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { s3, config, publicUrl } from "@/lib/s3";
import { ALLOWED_TYPES, MAX_BYTES, IMAGE_PREFIX, buildKey, nameFromKey } from "@/lib/images";

export const dynamic = "force-dynamic";

/** GET /api/images: every image in the library, newest first. */
export async function GET() {
  try {
    const items: { key: string; name: string; url: string; size: number; uploaded: string }[] = [];
    let token: string | undefined;
    do {
      const page = await s3().send(
        new ListObjectsV2Command({ Bucket: config.bucket, Prefix: IMAGE_PREFIX, ContinuationToken: token })
      );
      for (const o of page.Contents ?? []) {
        if (!o.Key || o.Key.endsWith("/")) continue;
        items.push({
          key: o.Key,
          name: nameFromKey(o.Key),
          url: publicUrl(o.Key),
          size: o.Size ?? 0,
          uploaded: (o.LastModified ?? new Date()).toISOString(),
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    items.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
    return NextResponse.json({ images: items });
  } catch (err) {
    console.error("list images failed", err);
    return NextResponse.json({ error: "Couldn’t load the image library. Check the AWS settings." }, { status: 500 });
  }
}

/**
 * POST /api/images  { name, type, size }
 * Returns a one-time upload pass. The browser then sends the file straight to S3,
 * and S3 itself enforces the type and size limits in the pass.
 */
export async function POST(req: Request) {
  let body: { name?: unknown; type?: unknown; size?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "image";
  const type = typeof body.type === "string" ? body.type : "";
  const size = typeof body.size === "number" ? body.size : NaN;

  if (!ALLOWED_TYPES[type]) {
    return NextResponse.json({ error: "Only JPG, PNG, GIF and WebP images can be uploaded." }, { status: 400 });
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    return NextResponse.json({ error: "Images must be under 10 MB." }, { status: 400 });
  }

  try {
    const key = buildKey(name, type);
    const { url, fields } = await createPresignedPost(s3(), {
      Bucket: config.bucket,
      Key: key,
      Expires: 120, // the pass works for 2 minutes
      Conditions: [
        ["content-length-range", 1, MAX_BYTES],
        ["eq", "$Content-Type", type],
        ["eq", "$Cache-Control", "public, max-age=31536000, immutable"],
      ],
      Fields: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
    return NextResponse.json({ upload: { url, fields }, key, publicUrl: publicUrl(key) });
  } catch (err) {
    console.error("presign failed", err);
    return NextResponse.json({ error: "Couldn’t start the upload. Check the AWS settings." }, { status: 500 });
  }
}
