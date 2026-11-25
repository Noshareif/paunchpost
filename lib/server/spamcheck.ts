import { extractLinks, htmlToText } from "./render";

/**
 * A pre-send look at the things spam filters weigh most. Returns plain-English warnings;
 * none of them block a send on their own (the hard rules live in readiness() and the safety caps).
 */
export function spamCheck(c: { subject: string; preview: string; html: string }, opts: { linkHost: string }): string[] {
  const w: string[] = [];
  const subject = String(c.subject || "");
  const html = String(c.html || "");
  const text = htmlToText(html).replace(/\s+/g, " ").trim();

  // Subject line
  const shouting = subject.split(/\s+/).filter(x => x.length > 3 && /[A-Z]/.test(x) && x === x.toUpperCase());
  if (shouting.length >= 2) w.push(`The subject has words in ALL CAPS (${shouting.slice(0, 3).join(", ")}). Spam filters penalize shouting.`);
  if (/[!?]{2,}/.test(subject)) w.push("The subject has repeated punctuation like “!!” or “?!”, a common spam signal.");
  const words = /\b(free|act now|guarantee[d]?|winner|cash|urgent|risk[- ]free|click here|limited time|100% |no cost|congratulations|order now|buy now)\b/i;
  const hit = subject.match(words);
  if (hit) w.push(`The subject uses “${hit[0].trim()}”, a phrase spam filters watch for. Consider rewording.`);
  if (subject.length > 90) w.push("The subject is very long (over 90 characters); most inboxes cut it off.");
  if (!String(c.preview || "").trim()) w.push("No preview text. Inboxes will show the first words of the email instead.");

  // Body
  const imgs = (html.match(/<img\b/gi) || []).length;
  if (imgs > 0 && text.length < 250) w.push("The email is mostly images with little text. Filters distrust image-only emails; add a few sentences of real text.");
  const noAlt = (html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) || []).length;
  if (noAlt) w.push(`${noAlt} image${noAlt > 1 ? "s have" : " has"} no alt text (shown when images are blocked).`);
  const links = extractLinks(html);
  const short = links.filter(u => /^https?:\/\/(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|rebrand\.ly|is\.gd|buff\.ly|cutt\.ly)\//i.test(u));
  if (short.length) w.push("It uses a link shortener (" + short[0].split("/")[2] + "). Spammers use these to hide where links go; use the full link instead.");
  const insecure = links.filter(u => /^http:\/\//i.test(u));
  if (insecure.length) w.push(`${insecure.length} link${insecure.length > 1 ? "s use" : " uses"} http:// instead of https://.`);
  if (links.length > 25) w.push(`It has ${links.length} links. Fewer, clearer links look less like spam.`);
  if (/<(script|form|iframe|object|embed)\b/i.test(html)) w.push("The HTML contains a script, form or embedded frame. Email clients strip these and filters penalize them.");
  const kb = Buffer.byteLength(html, "utf8") / 1024;
  if (kb > 95) w.push(`The email is ${Math.round(kb)} KB. Gmail cuts off emails over about 100 KB, hiding the unsubscribe link.`);

  // Where tracking links point
  if (/\.vercel\.app$/i.test(opts.linkHost)) {
    w.push(`Tracking and unsubscribe links point to ${opts.linkHost}, a shared hosting address. Moving them to a darkhorsetech.com address (like mail.darkhorsetech.com) helps deliverability.`);
  }
  return w;
}
