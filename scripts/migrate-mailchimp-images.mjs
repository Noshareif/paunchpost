#!/usr/bin/env node
// Copies every image your Mailchimp emails and templates point to into your own S3 bucket,
// then writes a new copy of the data file with the links swapped to images.darkhorsetech.com.
// Run it BEFORE cancelling Mailchimp, while Mailchimp still serves the images.
//
//   node scripts/migrate-mailchimp-images.mjs data/mailchimp.json
//
// Needs the same AWS_* / S3_BUCKET / IMAGES_BASE_URL variables as the app (see .env.example).
// It only reads the input file; output goes to <input>.migrated.json and image-map.csv.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/migrate-mailchimp-images.mjs data/mailchimp.json");
  process.exit(1);
}
for (const v of ["S3_BUCKET", "IMAGES_BASE_URL"]) {
  if (!process.env[v]) {
    console.error(`Set ${v} first (see .env.example).`);
    process.exit(1);
  }
}
const bucket = process.env.S3_BUCKET;
const base = process.env.IMAGES_BASE_URL.replace(/\/+$/, "");
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-2",
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
});

// Mailchimp-hosted image addresses.
const MC_IMG = /https?:\/\/(?:mcusercontent\.com|gallery\.mailchimp\.com|[a-z0-9-]+\.mcusercontent\.com)\/[^"'\s)<>]+/gi;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

const data = JSON.parse(await readFile(input, "utf8"));
const items = [...(data.campaigns || []), ...(data.templates || [])];
const urls = new Set();
for (const it of items) for (const m of String(it.html || "").matchAll(MC_IMG)) urls.add(m[0].replace(/&amp;/g, "&"));
console.log(`Found ${urls.size} Mailchimp-hosted images in ${items.length} emails and templates.`);

const map = new Map();
const failed = [];
let done = 0;
const queue = [...urls];

async function worker() {
  while (queue.length) {
    const url = queue.shift();
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const type = (r.headers.get("content-type") || "").split(";")[0].trim();
      const buf = Buffer.from(await r.arrayBuffer());
      const ext = EXT[type] || (url.match(/\.([a-z0-9]{3,4})(?:\?|$)/i)?.[1] ?? "bin").toLowerCase();
      // Same image always gets the same name, so running the script twice is safe.
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
      const key = `email/mailchimp/${hash}.${ext}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buf,
          ContentType: type || "application/octet-stream",
          CacheControl: "public, max-age=31536000, immutable",
        })
      );
      map.set(url, `${base}/${key}`);
    } catch (e) {
      failed.push([url, e.message]);
    }
    if (++done % 25 === 0) console.log(`  ${done}/${urls.size}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

let swapped = 0;
for (const it of items) {
  let h = String(it.html || "");
  for (const [from, to] of map) {
    const variants = [from, from.replace(/&/g, "&amp;")];
    for (const v of variants) {
      if (h.includes(v)) {
        h = h.split(v).join(to);
        swapped++;
      }
    }
  }
  it.html = h;
}

const out = input.replace(/\.json$/, "") + ".migrated.json";
await writeFile(out, JSON.stringify(data));
await writeFile(
  "image-map.csv",
  "mailchimp_url,new_url\n" + [...map].map(([a, b]) => `"${a}","${b}"`).join("\n") + "\n"
);
console.log(`Copied ${map.size} images, swapped ${swapped} links. Wrote ${out} and image-map.csv.`);
if (failed.length) {
  console.log(`${failed.length} images couldn’t be copied:`);
  for (const [u, e] of failed.slice(0, 20)) console.log("  " + e + "  " + u);
  process.exitCode = 2;
}
