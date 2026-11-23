import { after } from "next/server";
import { baseUrl, processBatch, startDueCampaigns } from "./send";
import { secret as getSecret } from "./secrets";

export function authorized(req: Request): boolean {
  const secret = getSecret("CRON_SECRET");
  if (!secret) return false;
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${secret}`;
}

/** Asks the app to run another batch right after this response (keeps a big send moving). */
export function kickWorker() {
  const secret = getSecret("CRON_SECRET");
  if (!secret) return;
  after(async () => {
    try {
      await fetch(`${baseUrl()}/api/worker`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    } catch (e) {
      console.error("could not kick worker", e);
    }
  });
}

/** One unit of work: start due scheduled campaigns, send a batch, chain if more is waiting. */
export async function tick() {
  const started = await startDueCampaigns();
  const r = await processBatch({ limit: 250, deadlineMs: 40_000 });
  if (r.remaining > 0) kickWorker();
  return { started, ...r };
}
