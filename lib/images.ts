// Rules for what can be uploaded and where it goes in the bucket.
// Shared by the API routes (server) and the upload screen (browser).

export const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB after in-browser resizing
export const IMAGE_PREFIX = "email/"; // everything PaunchPost uploads lives under this folder

/** Turns "Holiday Banner (final) v2.PNG" into "holiday-banner-final-v2". */
export function slugify(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]+$/i, "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image"
  );
}

/** email/2026/11/k3f9x2-holiday-banner.png. The random part keeps names unique and links permanent. */
export function buildKey(originalName: string, contentType: string, now = new Date()): string {
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) throw new Error("Unsupported image type");
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${IMAGE_PREFIX}${yyyy}/${mm}/${rand}-${slugify(originalName)}.${ext}`;
}

/** Display name back from a key: "k3f9x2-holiday-banner.png" -> "holiday-banner.png". */
export function nameFromKey(key: string): string {
  const file = key.split("/").pop() || key;
  return file.replace(/^[a-z0-9]{8}-/, "");
}

/** Only keys we created may be deleted. Blocks "../" tricks and other folders. */
export function isOurKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.startsWith(IMAGE_PREFIX) &&
    !key.includes("..") &&
    /^[a-z0-9/._-]+$/.test(key) &&
    key.length < 300
  );
}
