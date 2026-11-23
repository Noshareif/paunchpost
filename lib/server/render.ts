// Turns a campaign's HTML into the exact email one person receives.
// Pure functions (no database), so they're easy to test.

export type Person = {
  email: string;
  first_name?: string;
  last_name?: string;
  practice?: string;
  title?: string;
  phone?: string;
  custom?: Record<string, string>;
};

export type RenderOpts = {
  baseUrl: string; // https://paunchpost.vercel.app
  token: string; // this recipient's secret
  company: string;
  footerAddress: string;
  reminder: string;
  preview?: string;
  trackOpens?: boolean;
  trackClicks?: boolean;
  linkId?: (url: string) => number | undefined; // url -> links.id for click tracking
};

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function unsubscribeUrl(baseUrl: string, token: string) {
  return `${baseUrl}/u/${token}`;
}
export function browserUrl(baseUrl: string, token: string) {
  return `${baseUrl}/v/${token}`;
}

/** {{first_name}}, {{practice}}, {{first_name|there}} (fallback when blank), custom fields by tag. */
export function mergeTags(text: string, p: Person, extra: Record<string, string>, html = true) {
  const values: Record<string, string> = {
    email: p.email,
    first_name: p.first_name || "",
    last_name: p.last_name || "",
    practice: p.practice || "",
    title: p.title || "",
    phone: p.phone || "",
    ...(p.custom || {}),
  };
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (m, key: string, fallback?: string) => {
    const k = key.toLowerCase();
    if (k in extra) return extra[k]; // links: never escaped
    if (k in values) {
      const v = values[k] || fallback || "";
      return html ? esc(v) : v;
    }
    return fallback ?? ""; // unknown tag: drop it rather than show {{junk}}
  });
}

function footer(o: RenderOpts) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#7a7590;">${esc(o.reminder)}<br>${esc(o.company)} · ${esc(o.footerAddress)}<br><a href="{{unsubscribe_url}}" style="color:#7a7590;">Unsubscribe</a> &nbsp;·&nbsp; <a href="{{view_in_browser_url}}" style="color:#7a7590;">View in browser</a></td></tr></table>`;
}

function insertAfterBodyOpen(html: string, snippet: string) {
  const m = html.match(/<body[^>]*>/i);
  return m ? html.replace(m[0], m[0] + snippet) : snippet + html;
}
function insertBeforeBodyClose(html: string, snippet: string) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, snippet + "</body>") : html + snippet;
}

/** Links we never wrap for click tracking. */
const SKIP = /^(mailto:|tel:|sms:|#|\{\{)/i;

export function renderHtml(campaignHtml: string, p: Person, o: RenderOpts): string {
  let h = campaignHtml || "";
  // Every marketing email must carry an unsubscribe link and the mailing address (CAN-SPAM).
  if (!/\{\{\s*unsubscribe_url\s*\}\}/i.test(h)) h = insertBeforeBodyClose(h, footer(o));
  // Hidden preview text that inboxes show after the subject line.
  if (o.preview && !/mcnPreviewText|data-preheader/.test(h)) {
    h = insertAfterBodyOpen(
      h,
      `<div data-preheader style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:transparent;">${esc(o.preview)}${"&#847; &zwnj; &nbsp; ".repeat(30)}</div>`
    );
  }
  if (o.trackClicks !== false && o.linkId) {
    h = h.replace(/(<a\b[^>]*?\bhref\s*=\s*")([^"]+)(")/gi, (m, a: string, url: string, b: string) => {
      const raw = url.replace(/&amp;/g, "&").trim();
      if (SKIP.test(raw) || !/^https?:\/\//i.test(raw)) return m;
      const id = o.linkId!(raw);
      return id ? `${a}${o.baseUrl}/r/${o.token}/${id}${b}` : m;
    });
  }
  h = mergeTags(h, p, {
    unsubscribe_url: unsubscribeUrl(o.baseUrl, o.token),
    view_in_browser_url: browserUrl(o.baseUrl, o.token),
  });
  if (o.trackOpens !== false) {
    h = insertBeforeBodyClose(h, `<img src="${o.baseUrl}/o/${o.token}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`);
  }
  return h;
}

/** Every distinct http(s) link in the campaign, for the links table. */
export function extractLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of (html || "").matchAll(/<a\b[^>]*?\bhref\s*=\s*"([^"]+)"/gi)) {
    const u = m[1].replace(/&amp;/g, "&").trim();
    if (!SKIP.test(u) && /^https?:\/\//i.test(u)) out.add(u);
  }
  return [...out];
}

export function htmlToText(h: string): string {
  return h
    .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<div data-preheader[\s\S]*?<\/div>/i, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, u, t) => {
      const label = t.replace(/<[^>]+>/g, "").trim();
      return label && label !== u ? `${label} (${u})` : u;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|tr|div|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "’")
    .replace(/&quot;/g, '"')
    .replace(/&#?[a-z0-9]+;/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderText(campaignHtml: string, plain: string | null, p: Person, o: RenderOpts): string {
  const base = plain ?? htmlToText(campaignHtml);
  let t = mergeTags(base, p, { unsubscribe_url: unsubscribeUrl(o.baseUrl, o.token), view_in_browser_url: browserUrl(o.baseUrl, o.token) }, false);
  if (!t.includes(unsubscribeUrl(o.baseUrl, o.token))) {
    t += `\n\n--\n${o.reminder}\n${o.company} · ${o.footerAddress}\nUnsubscribe: ${unsubscribeUrl(o.baseUrl, o.token)}`;
  }
  return t;
}

export function renderSubject(subject: string, p: Person) {
  return mergeTags(subject, p, {}, false);
}
