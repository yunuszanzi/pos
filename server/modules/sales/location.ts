import { and, eq } from "drizzle-orm";
import { locations, type terminals } from "../../../db/schema";
import { db } from "../../lib/db";

/** Where a terminal's sales take stock from: the location set on the terminal, otherwise the oldest active store location of its branch. */
export async function resolveSalesLocationId(terminal: Pick<typeof terminals.$inferSelect, "businessId" | "branchId" | "salesLocationId">): Promise<string | null> {
  if (terminal.salesLocationId) return terminal.salesLocationId;
  const [location] = await db.select({ id: locations.id }).from(locations)
    .where(and(eq(locations.businessId, terminal.businessId), eq(locations.branchId, terminal.branchId), eq(locations.type, "store"), eq(locations.active, true)))
    .orderBy(locations.createdAt).limit(1);
  return location?.id ?? null;
}
