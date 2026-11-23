import crypto from "node:crypto";
import { handleSesEvent } from "@/lib/server/ses-events";

export const dynamic = "force-dynamic";

// Amazon SES → Amazon SNS → here. Bounces and spam complaints are suppressed immediately,
// so PaunchPost never emails those addresses again (Amazon reviews accounts with high rates).

const certCache = new Map<string, string>();

async function verifySns(m: Record<string, string>): Promise<boolean> {
  const certUrl = m.SigningCertURL || m.SigningCertUrl;
  let u: URL;
  try {
    u = new URL(certUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname) || !u.pathname.endsWith(".pem")) return false;
  const keys =
    m.Type === "Notification"
      ? ["Message", "MessageId", ...(m.Subject ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const toSign = keys.map(k => `${k}\n${m[k]}\n`).join("");
  let pem = certCache.get(certUrl);
  if (!pem) {
    const r = await fetch(certUrl);
    if (!r.ok) return false;
    pem = await r.text();
    certCache.set(certUrl, pem);
  }
  const algo = m.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  return crypto.verify(algo, Buffer.from(toSign, "utf8"), pem, Buffer.from(m.Signature, "base64"));
}

export async function POST(req: Request) {
  // Extra shared secret in the subscription URL: /api/ses/events?key=...
  const key = new URL(req.url).searchParams.get("key");
  if (!process.env.SES_WEBHOOK_KEY || key !== process.env.SES_WEBHOOK_KEY) return new Response("Forbidden", { status: 403 });

  let m: Record<string, string>;
  try {
    m = JSON.parse(await req.text());
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (process.env.SES_SNS_TOPIC_ARN && m.TopicArn !== process.env.SES_SNS_TOPIC_ARN) return new Response("Wrong topic", { status: 403 });
  if (!(await verifySns(m))) return new Response("Bad signature", { status: 403 });

  if (m.Type === "SubscriptionConfirmation") {
    const u = new URL(m.SubscribeURL);
    if (u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) await fetch(u);
    return new Response("Confirmed");
  }
  if (m.Type !== "Notification") return new Response("Ignored");

  let ev: any;
  try {
    ev = JSON.parse(m.Message);
  } catch {
    return new Response("Ignored");
  }
  await handleSesEvent(ev);
  return new Response("OK");
}
