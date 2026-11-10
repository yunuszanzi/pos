// @vitest-environment node
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../../server/app";
import { captureError, checkFbrHealth, parseSentryDsn, raiseAlert, sentryEnvelope } from "../../server/lib/monitoring";
import { createTestBusiness, hasLocalStack, sql } from "./helpers";

// v1.0 observability (NFR-OBS-01): unhandled errors go to Sentry, and an alert is raised when more than 5% of FBR calls in an hour fail.
// Sentry and the alert webhook are local servers here that record what they are sent.

type Received = { url: string; headers: IncomingMessage["headers"]; body: string };
async function listener() {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { received.push({ url: request.url ?? "", headers: request.headers, body }); response.writeHead(200).end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { received, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.SENTRY_DSN;
  delete process.env.ALERT_WEBHOOK_URL;
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("Sentry", () => {
  it("reads a DSN and refuses what is not one", () => {
    expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/4501")).toEqual({ key: "abc123", endpoint: "https://o1.ingest.sentry.io/api/4501/envelope/" });
    expect(parseSentryDsn("http://k@127.0.0.1:9000/7")).toEqual({ key: "k", endpoint: "http://127.0.0.1:9000/api/7/envelope/" });
    for (const bad of [undefined, "", "not a url", "https://host/4501", "https://key@host/", "https://key@host/abc"]) expect(parseSentryDsn(bad)).toBeNull();
  });

  it("builds an envelope of three lines: where it is from, what it is, and the error", () => {
    const lines = sentryEnvelope("https://k@h/1", new TypeError("boom"), { path: "/api/v1/x" }).split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ dsn: "https://k@h/1" });
    expect(lines[1]).toEqual({ type: "event" });
    expect(lines[2]).toMatchObject({ level: "error", platform: "node", tags: { path: "/api/v1/x" }, exception: { values: [{ type: "TypeError", value: "boom" }] } });
    expect(lines[2].event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(lines[0].event_id).toBe(lines[2].event_id);
  });

  it("sends an unhandled error to Sentry when it is set up, and only logs it when it is not", async () => {
    const sentry = await listener();
    closers.push(sentry.close);
    await captureError(new Error("not set up yet"));
    expect(sentry.received).toHaveLength(0);
    process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${sentry.port}/42`;
    await captureError(new Error("the till fell over"), { path: "/api/v1/sales" });
    expect(sentry.received).toHaveLength(1);
    expect(sentry.received[0].url).toBe("/api/v1/../api/42/envelope/".replace("/api/v1/..", ""));
    expect(sentry.received[0].headers["x-sentry-auth"]).toContain("sentry_key=publickey");
    expect(sentry.received[0].body).toContain("the till fell over");
  });

  it("never lets a Sentry that is down break the request", async () => {
    process.env.SENTRY_DSN = "http://k@127.0.0.1:1/1";
    await expect(captureError(new Error("still fine"))).resolves.toBeUndefined();
  });
});

integration_alerts();

function integration_alerts() {
  describe.skipIf(!hasLocalStack)("alerts", { timeout: 60_000 }, () => {
    it("raises an alert once an hour for the same trouble, and says it on the webhook", async () => {
      const hook = await listener();
      closers.push(hook.close);
      process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${hook.port}/hook`;
      const business = await createTestBusiness();
      expect(await raiseAlert("test-alert", business.businessId, "Something is wrong")).toBe(true);
      expect(await raiseAlert("test-alert", business.businessId, "Something is still wrong")).toBe(false);
      expect(await raiseAlert("other-alert", business.businessId, "Something else")).toBe(true);
      expect(hook.received.map((entry) => JSON.parse(entry.body).text)).toEqual(["POS alert (test-alert): Something is wrong", "POS alert (other-alert): Something else"]);
    });

    async function withAttempts(outcomes: Array<[step: string, outcome: string]>) {
      const business = await createTestBusiness();
      const database = sql();
      try {
        const [submission] = await database<{ id: string }[]>`
          insert into fbr_submissions (business_id, doc_type, doc_id, number, channel, environment) values (${business.businessId}, 'sales_invoice', gen_random_uuid(), 'T-1', 'di', 'sandbox') returning id`;
        let n = 0;
        for (const [step, outcome] of outcomes) {
          n += 1;
          await database`insert into fbr_attempts (business_id, submission_id, attempt_no, step, outcome) values (${business.businessId}, ${submission.id}, ${n}, ${step}, ${outcome})`;
        }
      } finally {
        await database.end();
      }
      return business;
    }
    const mine = async (businessId: string) => (await checkFbrHealth()).find((row) => row.businessId === businessId);

    it("alerts when more than 5% of FBR calls in the last hour failed", async () => {
      const hook = await listener();
      closers.push(hook.close);
      process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${hook.port}/hook`;
      // 20 calls (10 checks, 10 postings), 2 of them did not succeed: 10%.
      const business = await withAttempts([...Array.from({ length: 9 }, () => ["validate", "valid"] as [string, string]), ["validate", "transient"], ...Array.from({ length: 9 }, () => ["post", "accepted"] as [string, string]), ["post", "unauthorised"]]);
      const first = await mine(business.businessId);
      expect(first).toMatchObject({ calls: 20, failed: 2, alerted: true });
      expect(first!.rate).toBeCloseTo(0.1);
      expect(hook.received).toHaveLength(1);
      expect(JSON.parse(hook.received[0].body).text).toContain("2 of 20 calls");
      // The next run, a minute later, says nothing more.
      expect((await mine(business.businessId))!.alerted).toBe(false);
      expect(hook.received).toHaveLength(1);
    });

    it("leaves FBR alone when it is healthy, when the failures are few, and when there are too few calls to say", async () => {
      const healthy = await withAttempts(Array.from({ length: 40 }, () => ["post", "accepted"] as [string, string]));
      expect(await mine(healthy.businessId)).toMatchObject({ calls: 40, failed: 0, alerted: false });
      // 1 in 40 is 2.5%.
      const fine = await withAttempts([["post", "transient"], ...Array.from({ length: 39 }, () => ["post", "accepted"] as [string, string])]);
      expect(await mine(fine.businessId)).toMatchObject({ calls: 40, failed: 1, alerted: false });
      // Two in three is a high rate, but three calls prove nothing.
      const few = await withAttempts([["post", "transient"], ["post", "transient"], ["post", "accepted"]]);
      expect(await mine(few.businessId)).toMatchObject({ calls: 3, failed: 2, alerted: false });
      // Our own pre-checks are not FBR's answers.
      const local = await withAttempts(Array.from({ length: 30 }, () => ["local", "rejected"] as [string, string]));
      expect(await mine(local.businessId)).toBeUndefined();
    });

    it("is reachable by the scheduler, behind its secret", async () => {
      process.env.CRON_SECRET = "test-cron-secret-0123456789abcdef";
      expect((await app.fetch(new Request("http://localhost/api/jobs/fbr-health"))).status).toBe(401);
      const ok = await app.fetch(new Request("http://localhost/api/jobs/fbr-health", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toHaveProperty("businesses");
    });
  });
}
