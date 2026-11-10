import { and, asc, eq } from "drizzle-orm";
import { branches, locations, terminals } from "../../../db/schema";
import { db } from "../../lib/db";

/** Where a terminal's sales take stock from: the location set on the terminal, otherwise the oldest active store location of its branch. */
export async function resolveSalesLocationId(terminal: Pick<typeof terminals.$inferSelect, "businessId" | "branchId" | "salesLocationId">): Promise<string | null> {
  if (terminal.salesLocationId) return terminal.salesLocationId;
  const [location] = await db.select({ id: locations.id }).from(locations)
    .where(and(eq(locations.businessId, terminal.businessId), eq(locations.branchId, terminal.branchId), eq(locations.type, "store"), eq(locations.active, true)))
    .orderBy(locations.createdAt).limit(1);
  return location?.id ?? null;
}

/** The branch a back-office document belongs to: the one named, else the till's, else the first branch of the business. */
export async function resolveBranchId(businessId: string, requested: string | undefined, terminalId: string | null): Promise<string | null> {
  if (requested) {
    const [branch] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.id, requested), eq(branches.businessId, businessId))).limit(1);
    return branch?.id ?? null;
  }
  if (terminalId) {
    const [terminal] = await db.select({ branchId: terminals.branchId }).from(terminals).where(and(eq(terminals.id, terminalId), eq(terminals.businessId, businessId))).limit(1);
    if (terminal) return terminal.branchId;
  }
  const [first] = await db.select({ id: branches.id }).from(branches).where(eq(branches.businessId, businessId)).orderBy(asc(branches.createdAt)).limit(1);
  return first?.id ?? null;
}

/** Where a back-office order takes its stock from: the location named (if it is the business's and active), else the oldest active store of the branch. */
export async function resolveOrderLocationId(businessId: string, branchId: string, requested?: string): Promise<string | null> {
  if (requested) {
    const [location] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, requested), eq(locations.businessId, businessId), eq(locations.active, true))).limit(1);
    return location?.id ?? null;
  }
  const [location] = await db.select({ id: locations.id }).from(locations)
    .where(and(eq(locations.businessId, businessId), eq(locations.branchId, branchId), eq(locations.type, "store"), eq(locations.active, true)))
    .orderBy(locations.createdAt).limit(1);
  return location?.id ?? null;
}
