import { S3Client } from "@aws-sdk/client-s3";

// Settings come from environment variables (set them in Vercel, never in the code).
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export const config = {
  get region() {
    return process.env.AWS_REGION || "us-east-2";
  },
  get bucket() {
    return required("S3_BUCKET");
  },
  /** Public address images are served from, e.g. https://images.darkhorsetech.com */
  get publicBaseUrl() {
    return required("IMAGES_BASE_URL").replace(/\/+$/, "");
  },
};

let client: S3Client | null = null;

export function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: config.region,
      // Only used for local testing against a fake S3. Leave unset in production.
      ...(process.env.S3_ENDPOINT
        ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
        : {}),
      // Uses AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the environment.
    });
  }
  return client;
}

export function publicUrl(key: string): string {
  return `${config.publicBaseUrl}/${key}`;
}
