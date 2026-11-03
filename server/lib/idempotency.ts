import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { idempotencyKeys } from "../../db/schema";
import { db } from "./db";
import { apiError } from "./http";
import { getPrincipal } from "./permissions";

// A claim without a response is "in flight". If the server died mid-request it never completes, so a
// claim older than this can be taken over by a retry.
const staleClaimMs = 2 * 60 * 1000;

/**
 * Makes a posting write safe to retry. The client sends `Idempotency-Key`; the first request with a key
 * runs and its response is stored, later requests with the same key and body get that response back
 * (`Idempotent-Replay: true`) instead of running again. Only successful responses are stored, so a failed
 * attempt can be retried with the same key. Place it after the permission check and before body validation.
 */
export function idempotent(): MiddlewareHandler {
  return async (context, next) => {
    const principal = getPrincipal(context);
    const key = context.req.header("Idempotency-Key")?.trim();
    if (!key || key.length < 8 || key.length > 200) {
      return apiError(context, 400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header of 8 to 200 characters");
    }
    const businessId = principal.businessId!;
    const requestHash = createHash("sha256")
      .update(`${context.req.method} ${new URL(context.req.url).pathname}\n${await context.req.text()}`)
      .digest("hex");

    const [claimed] = await db.insert(idempotencyKeys).values({ businessId, key, requestHash })
      .onConflictDoNothing().returning({ key: idempotencyKeys.key });

    if (!claimed) {
      const [existing] = await db.select().from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.businessId, businessId), eq(idempotencyKeys.key, key))).limit(1);
      if (!existing) return apiError(context, 409, "REQUEST_IN_PROGRESS", "Try again in a moment");
      if (existing.requestHash !== requestHash) {
        return apiError(context, 422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
      }
      if (existing.statusCode !== null) {
        context.header("Idempotent-Replay", "true");
        return context.json(existing.response as object, existing.statusCode as 200);
      }
      const [takenOver] = await db.update(idempotencyKeys).set({ createdAt: new Date() })
        .where(and(
          eq(idempotencyKeys.businessId, businessId),
          eq(idempotencyKeys.key, key),
          lt(idempotencyKeys.createdAt, sql`now() - ${`${staleClaimMs} milliseconds`}::interval`),
        )).returning({ key: idempotencyKeys.key });
      if (!takenOver) return apiError(context, 409, "REQUEST_IN_PROGRESS", "This request is already being processed");
    }

    const release = () => db.delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.businessId, businessId), eq(idempotencyKeys.key, key)));
    try {
      await next();
    } catch (error) {
      await release();
      throw error;
    }
    if (context.res.status >= 200 && context.res.status < 300) {
      const body = await context.res.clone().json() as object;
      await db.update(idempotencyKeys).set({ statusCode: context.res.status, response: body })
        .where(and(eq(idempotencyKeys.businessId, businessId), eq(idempotencyKeys.key, key)));
    } else {
      await release();
    }
  };
}
