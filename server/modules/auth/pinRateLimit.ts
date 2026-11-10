import { eq, sql } from "drizzle-orm";
import { pinAttempts } from "../../../db/schema";
import { db } from "../../lib/db";

const maximumAttempts = 5;
// Computed in the database so the window never depends on how a JS Date is serialised.
const windowExpired = sql`${pinAttempts.windowStartedAt} <= now() - interval '15 minutes'`;

export async function registerPinAttempt(rateKey: string): Promise<{ allowed: boolean }> {
  const [attempt] = await db.insert(pinAttempts).values({
    rateKey,
    attempts: 1,
  }).onConflictDoUpdate({
    target: pinAttempts.rateKey,
    set: {
      attempts: sql`CASE WHEN ${windowExpired} THEN 1 ELSE ${pinAttempts.attempts} + 1 END`,
      windowStartedAt: sql`CASE WHEN ${windowExpired} THEN now() ELSE ${pinAttempts.windowStartedAt} END`,
    },
  }).returning({ attempts: pinAttempts.attempts });
  return { allowed: attempt.attempts <= maximumAttempts };
}

export async function clearPinAttempts(rateKey: string): Promise<void> {
  await db.delete(pinAttempts).where(eq(pinAttempts.rateKey, rateKey));
}
