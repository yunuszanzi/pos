import { eq, sql } from "drizzle-orm";
import { pinAttempts } from "../../../db/schema";
import { db } from "../../lib/db";

const windowMs = 15 * 60 * 1000;
const maximumAttempts = 5;

export async function registerPinAttempt(rateKey: string): Promise<{ allowed: boolean }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);
  const [attempt] = await db.insert(pinAttempts).values({
    rateKey,
    attempts: 1,
    windowStartedAt: now,
  }).onConflictDoUpdate({
    target: pinAttempts.rateKey,
    set: {
      attempts: sql`CASE WHEN ${pinAttempts.windowStartedAt} <= ${cutoff} THEN 1 ELSE ${pinAttempts.attempts} + 1 END`,
      windowStartedAt: sql`CASE WHEN ${pinAttempts.windowStartedAt} <= ${cutoff} THEN ${now} ELSE ${pinAttempts.windowStartedAt} END`,
    },
  }).returning({ attempts: pinAttempts.attempts });
  return { allowed: attempt.attempts <= maximumAttempts };
}

export async function clearPinAttempts(rateKey: string): Promise<void> {
  await db.delete(pinAttempts).where(eq(pinAttempts.rateKey, rateKey));
}
