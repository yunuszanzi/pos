import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";

// Telling people when something is wrong (NFR-OBS-01), without tying the system to one vendor.
//   SENTRY_DSN        unhandled errors are sent to Sentry (its envelope endpoint, over plain fetch, no extra package).
//   ALERT_WEBHOOK_URL alerts (such as FBR failing too often) are posted as {"text": "..."}, which Slack and many others accept.
// With neither set, both are written to the server log, which Vercel keeps. A failure to report is never allowed to break a request.

const timeoutMs = 3000;

async function post(url: string, init: RequestInit): Promise<void> {
  try {
    await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Nowhere left to report that the report failed.
  }
}

/** The parts of a Sentry DSN (https://<key>@<host>/<project>) that the envelope endpoint needs, or null if it is not one. */
export function parseSentryDsn(dsn: string | undefined): { key: string; endpoint: string } | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const project = url.pathname.replace(/^\/+/, "");
    if (!url.username || !/^\d+$/.test(project)) return null;
    return { key: url.username, endpoint: `${url.protocol}//${url.host}/api/${project}/envelope/` };
  } catch {
    return null;
  }
}

/** The envelope Sentry takes for one error: a header line, an item header line and the event itself. */
export function sentryEnvelope(dsn: string, error: unknown, context: Record<string, string> = {}): string {
  const eventId = randomUUID().replaceAll("-", "");
  const err = error instanceof Error ? error : new Error(String(error));
  const event = {
    event_id: eventId, timestamp: Date.now() / 1000, platform: "node", level: "error", environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames: (err.stack ?? "").split("\n").slice(1, 30).map((line) => ({ filename: line.trim() })).reverse() } }] },
    tags: context,
  };
  return [JSON.stringify({ event_id: eventId, dsn, sent_at: new Date().toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
}

/** An error nobody handled. Always logged; sent to Sentry when it is set up. */
export async function captureError(error: unknown, context: Record<string, string> = {}): Promise<void> {
  console.error("Unhandled API error", error);
  const dsn = process.env.SENTRY_DSN;
  const parsed = parseSentryDsn(dsn);
  if (!dsn || !parsed) return;
  await post(parsed.endpoint, {
    method: "POST", body: sentryEnvelope(dsn, error, context),
    headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=pos-api/1.0` },
  });
}

/**
 * Raises an alert, at most once an hour for the same key and business. Returns whether it was sent (false: it was raised recently).
 * The log line is always written; the webhook is used when set.
 */
export async function raiseAlert(key: string, businessId: string | null, message: string): Promise<boolean> {
  const [recent] = await db.execute<{ recent: boolean }>(sql`
    select exists (select 1 from alert_log where key = ${key} and business_id is not distinct from ${businessId} and raised_at > now() - interval '1 hour') as recent`);
  if (recent.recent) return false;
  await db.execute(sql`insert into alert_log (key, business_id, message) values (${key}, ${businessId}, ${message})`);
  console.error(`ALERT ${key}: ${message}`);
  const webhook = process.env.ALERT_WEBHOOK_URL;
  if (webhook) await post(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `POS alert (${key}): ${message}` }) });
  return true;
}

export const fbrFailureThreshold = { rate: 0.05, minimumCalls: 10 };

/**
 * How FBR has answered in the last hour, per business: calls made, and how many did not succeed (refused, unreachable or token refused).
 * An alert is raised when more than 5% failed over at least ten calls (NFR-OBS-01). Small samples are left alone: one failure in three
 * is not a trend.
 */
export async function checkFbrHealth(): Promise<Array<{ businessId: string; calls: number; failed: number; rate: number; alerted: boolean }>> {
  const rows = await db.execute<{ business_id: string; calls: number; failed: number }>(sql`
    select business_id, count(*)::int as calls, count(*) filter (where outcome not in ('valid', 'accepted'))::int as failed
    from fbr_attempts where step in ('validate', 'post') and created_at > now() - interval '1 hour' group by business_id`);
  const results = [];
  for (const row of rows) {
    const rate = row.calls ? row.failed / row.calls : 0;
    const alerted = row.calls >= fbrFailureThreshold.minimumCalls && rate > fbrFailureThreshold.rate
      ? await raiseAlert("fbr-failure-rate", row.business_id, `FBR did not accept ${row.failed} of ${row.calls} calls in the last hour (${(rate * 100).toFixed(1)}%). Check the FBR log.`)
      : false;
    results.push({ businessId: row.business_id, calls: row.calls, failed: row.failed, rate, alerted });
  }
  return results;
}
