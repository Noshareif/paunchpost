import { db } from "./db";

/** Applies one Amazon SES event (from SNS) to the database. */
export async function handleSesEvent(ev: any) {
  const sql = db();
  const type: string = ev.eventType || ev.notificationType || "Unknown";
  const messageId: string | undefined = ev.mail?.messageId;
  const [send] = messageId ? await sql`select id, campaign_id from sends where ses_message_id = ${messageId}` : [];
  const sendId = send?.id ?? null;

  const log = async (email: string | null) =>
    sql`insert into events (type, send_id, email, payload) values (${type}, ${sendId}, ${email}, ${sql.json(ev)})`;

  if (type === "Bounce") {
    const permanent = ev.bounce?.bounceType === "Permanent";
    for (const r of ev.bounce?.bouncedRecipients ?? []) {
      const email = String(r.emailAddress || "").toLowerCase();
      await log(email);
      if (!permanent) continue; // soft bounces (full inbox etc.) are retried by SES
      await sql`insert into suppressions (email, reason, source) values (${email}, 'hard_bounce', ${"campaign " + (send?.campaign_id ?? "?")}) on conflict (email) do nothing`;
      await sql`update contacts set status = 'cleaned', updated_at = now() where lower(email) = ${email}`;
      if (sendId) await sql`update sends set status = 'bounced', error = ${String(r.diagnosticCode || "Hard bounce").slice(0, 500)} where id = ${sendId}`;
    }
  } else if (type === "Complaint") {
    for (const r of ev.complaint?.complainedRecipients ?? []) {
      const email = String(r.emailAddress || "").toLowerCase();
      await log(email);
      await sql`insert into suppressions (email, reason, source) values (${email}, 'complaint', ${"campaign " + (send?.campaign_id ?? "?")}) on conflict (email) do update set reason = 'complaint'`;
      await sql`update contacts set status = 'unsubscribed', updated_at = now() where lower(email) = ${email}`;
      if (sendId) await sql`update sends set status = 'complained' where id = ${sendId}`;
    }
  } else if (type === "Delivery") {
    if (sendId) await sql`update sends set delivered_at = coalesce(delivered_at, now()) where id = ${sendId}`;
  } else {
    await log(ev.mail?.destination?.[0] ?? null);
  }
}
