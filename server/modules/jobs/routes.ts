import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { fbrReferenceKinds } from "../../../shared/fbr";
import { clientFor, loadFbrSettings } from "../../fbr/config";
import { runDueSubmissions } from "../../fbr/service";
import { db } from "../../lib/db";
import { checkFbrHealth } from "../../lib/monitoring";
import { apiError } from "../../lib/http";

// Work done on a schedule, not by a person: the FBR retries and the daily refresh of FBR's own lists. These endpoints sit outside the signed-in
// API, so they are protected by a secret that only the scheduler holds (CRON_SECRET). With no secret set they refuse everything.

export const jobRoutes = new Hono();

function authorised(context: Context): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return apiError(context, 503, "JOBS_DISABLED", "Scheduled jobs are switched off: CRON_SECRET is not set on the server");
  const given = /^Bearer (.+)$/.exec(context.req.header("Authorization") ?? "")?.[1] ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return apiError(context, 401, "UNAUTHORIZED", "Not allowed");
  return null;
}

// Vercel Cron calls with GET; a plain scheduler may POST.
const retry = async (context: Context) => {
  const refused = authorised(context);
  if (refused) return refused;
  // The scheduler runs it for everyone; ?businessId= narrows it to one business (for a support person, or a test).
  const only = context.req.query("businessId");
  const outcome = await runDueSubmissions(Number(context.req.query("limit") ?? 25) || 25, only && /^[0-9a-f-]{36}$/i.test(only) ? only : undefined);
  await checkFbrHealth().catch(() => undefined);
  return context.json(outcome);
};
/** How FBR has answered over the last hour; raises an alert (once an hour) when more than 5% of calls did not succeed. */
const health = async (context: Context) => {
  const refused = authorised(context);
  if (refused) return refused;
  return context.json({ businesses: await checkFbrHealth() });
};
jobRoutes.get("/fbr-health", health);
jobRoutes.post("/fbr-health", health);

jobRoutes.get("/fbr-retry", retry);
jobRoutes.post("/fbr-retry", retry);

/** Refreshes FBR's reference lists for every business that has FBR on. A list FBR could not give is left as it was. */
const sync = async (context: Context) => {
  const refused = authorised(context);
  if (refused) return refused;
  const businesses = await db.execute<{ business_id: string }>(sql`select business_id from fbr_config where enabled and token_encrypted is not null`);
  let synced = 0;
  for (const { business_id: businessId } of businesses) {
    const client = await clientFor(businessId, await loadFbrSettings(businessId)).catch(() => null);
    if (!client) continue;
    for (const kind of fbrReferenceKinds) {
      const fetched = await client.fetchReference(kind);
      if (!fetched.ok) continue;
      await db.transaction(async (tx) => {
        await tx.execute(sql`delete from fbr_reference_data where business_id = ${businessId} and kind = ${kind}`);
        for (let at = 0; at < fetched.items.length; at += 500) {
          const chunk = fetched.items.slice(at, at + 500);
          await tx.execute(sql`insert into fbr_reference_data (business_id, kind, code, description, payload) values ${sql.join(chunk.map((item) => sql`(${businessId}, ${kind}, ${item.code}, ${item.description}, ${JSON.stringify(item.payload)}::jsonb)`), sql`, `)} on conflict (business_id, kind, code) do nothing`);
        }
      });
      synced += 1;
    }
    await db.execute(sql`update fbr_config set last_sync_at = now() where business_id = ${businessId}`);
  }
  return context.json({ businesses: businesses.length, listsSynced: synced });
};
jobRoutes.get("/fbr-sync", sync);
jobRoutes.post("/fbr-sync", sync);
