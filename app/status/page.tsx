import { db } from "@/lib/server/db";

export const dynamic = "force-dynamic";

/** Temporary home page until the full interface lands: shows the engine is connected. */
export default async function Status({ searchParams }: { searchParams: Promise<{ setup?: string }> }) {
  const sp = await searchParams;
  let rows: { label: string; value: string }[] = [];
  let error = "";
  try {
    const sql = db();
    const [c] = await sql`select
      (select count(*) from campaigns)::int as campaigns,
      (select count(*) from campaigns where imported)::int as imported,
      (select count(*) from templates)::int as templates,
      (select count(*) from contacts)::int as contacts,
      (select count(*) from suppressions)::int as suppressed,
      (select count(*) from sends where status = 'queued')::int as queued`;
    rows = [
      { label: "Campaigns", value: `${c.campaigns} (${c.imported} from Mailchimp)` },
      { label: "Templates", value: String(c.templates) },
      { label: "Contacts", value: String(c.contacts) },
      { label: "Suppressed addresses", value: String(c.suppressed) },
      { label: "Emails waiting to send", value: String(c.queued) },
    ];
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <div className="content">
      <div className="page-h"><div><h1>PaunchPost engine</h1><div className="sub">The full interface is on its way. This page confirms the database is connected.</div></div></div>
      {sp.setup && <div className="notice ok">Database set up. {sp.setup} Mailchimp campaigns loaded.</div>}
      {error && (
        <div className="card mb"><div className="card-b">
          <p style={{ marginTop: 0 }}>The database is connected but empty. This creates the tables and loads your Mailchimp history (takes about 30 seconds).</p>
          <form method="post" action="/api/admin/setup"><button className="btn pri" type="submit">Set up database</button></form>
          <div className="small muted mt">Details: {error}</div>
        </div></div>
      )}
      {!error && (
        <div className="card"><div className="card-b">{rows.map(r => <div key={r.label} className="flex between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}><span>{r.label}</span><b>{r.value}</b></div>)}</div></div>
      )}
    </div>
  );
}
