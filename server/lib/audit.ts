import type { Context } from "hono";
import { auditLog } from "../../db/schema";
import { db } from "./db";
import type { Principal } from "./permissions";

type AuditEntry = {
  businessId: string;
  entity: string;
  entityId: string;
  action: string;
  userId?: string | null;
  terminalId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

export async function writeAudit(entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    businessId: entry.businessId,
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    userId: entry.userId ?? null,
    terminalId: entry.terminalId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

export async function auditPrincipal(
  context: Context,
  principal: Principal,
  entity: string,
  entityId: string,
  action: string,
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
): Promise<void> {
  if (!principal.businessId) return;
  await writeAudit({
    businessId: principal.businessId,
    entity,
    entityId,
    action,
    userId: principal.activeUserId ?? principal.userId,
    terminalId: context.req.header("X-Terminal-Id"),
    before,
    after,
  });
}
