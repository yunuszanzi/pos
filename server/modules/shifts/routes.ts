import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { cashMovements, shifts, terminals } from "../../../db/schema";
import { cashMovementSchema, closeShiftSchema, openShiftSchema } from "../../../shared/schemas/shifts";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, hasPermission, requirePermission, type Principal } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";

export const shiftsRoutes = new Hono();

const shiftView = (row: typeof shifts.$inferSelect, showExpected: boolean) => ({
  id: row.id,
  terminalId: row.terminalId,
  status: row.status,
  openedBy: row.openedBy,
  openedAt: row.openedAt,
  openingFloatPaisa: row.openingFloatPaisa,
  closedBy: row.closedBy,
  closedAt: row.closedAt,
  countedPaisa: row.countedPaisa,
  countedBreakdown: row.countedBreakdown,
  note: row.note,
  // The expected cash stays hidden from the cashier until the count is in (blind count, FR-CSH-03).
  ...(showExpected || row.status === "closed" ? { expectedPaisa: row.expectedPaisa, variancePaisa: row.variancePaisa } : {}),
});

type Executor = Pick<typeof db, "execute" | "select">;

/** What a shift has taken, worked out from the posted documents. The same numbers feed the X and Z reports. */
async function summarise(executor: Executor, businessId: string, shiftId: string, openingFloatPaisa: number) {
  const [sales] = await executor.execute(sql`
    select count(*)::int as invoices, coalesce(sum(total_paisa), 0)::bigint as total, coalesce(sum(balance_paisa), 0)::bigint as credit,
           coalesce(sum(tax_paisa), 0)::bigint as tax,
           coalesce(sum(line_discount_paisa + invoice_discount_paisa), 0)::bigint as discount, coalesce(sum(rounding_paisa), 0)::bigint as rounding
    from sales_invoices where business_id = ${businessId} and shift_id = ${shiftId}
  `);
  const byMethod = await executor.execute(sql`
    select p.method_code, p.method_name, p.tender_kind, count(*)::int as payments, sum(p.amount_paisa)::bigint as amount
    from payments p join sales_invoices i on i.id = p.invoice_id
    where i.business_id = ${businessId} and i.shift_id = ${shiftId}
    group by p.method_code, p.method_name, p.tender_kind order by p.method_name
  `);
  const [moves] = await executor.execute(sql`
    select coalesce(sum(amount_paisa) filter (where kind = 'cash_in'), 0)::bigint as cash_in,
           coalesce(sum(amount_paisa) filter (where kind = 'cash_out'), 0)::bigint as cash_out
    from cash_movements where business_id = ${businessId} and shift_id = ${shiftId}
  `);
  // Money taken from customers against their khata, outside any sale.
  const [received] = await executor.execute(sql`
    select coalesce(sum(amount_paisa), 0)::bigint as total, coalesce(sum(amount_paisa) filter (where tender_kind = 'cash'), 0)::bigint as cash
    from customer_payments where business_id = ${businessId} and shift_id = ${shiftId}
  `);
  // Money handed back for returns. Only cash comes out of the drawer.
  const [refunds] = await executor.execute(sql`
    select coalesce(sum(refund_paisa), 0)::bigint as total, coalesce(sum(refund_paisa) filter (where refund_tender_kind = 'cash'), 0)::bigint as cash,
           coalesce(sum(total_paisa), 0)::bigint as returned, count(*)::int as returns
    from sales_returns where business_id = ${businessId} and shift_id = ${shiftId}
  `);
  // Money paid to suppliers. Only cash comes out of the drawer.
  const [supplierPaid] = await executor.execute(sql`
    select coalesce(sum(amount_paisa), 0)::bigint as total, coalesce(sum(amount_paisa) filter (where tender_kind = 'cash'), 0)::bigint as cash
    from supplier_payments where business_id = ${businessId} and shift_id = ${shiftId}
  `);
  // Payments are stored at the amount that counts towards the bill, so change given back is already left out.
  const cashSales = byMethod.filter((row) => row.tender_kind === "cash").reduce((total, row) => total + Number(row.amount), 0);
  const cashIn = Number(moves.cash_in);
  const cashOut = Number(moves.cash_out);
  return {
    invoiceCount: Number(sales.invoices),
    totalPaisa: Number(sales.total),
    creditSalesPaisa: Number(sales.credit),
    customerPaymentsPaisa: Number(received.total),
    customerPaymentsCashPaisa: Number(received.cash),
    returnCount: Number(refunds.returns),
    returnsPaisa: Number(refunds.returned),
    refundsCashPaisa: Number(refunds.cash),
    supplierPaymentsPaisa: Number(supplierPaid.total),
    supplierPaymentsCashPaisa: Number(supplierPaid.cash),
    taxPaisa: Number(sales.tax),
    discountPaisa: Number(sales.discount),
    roundingPaisa: Number(sales.rounding),
    byMethod: byMethod.map((row) => ({ code: String(row.method_code), name: String(row.method_name), payments: Number(row.payments), amountPaisa: Number(row.amount) })),
    cashSalesPaisa: cashSales,
    cashInPaisa: cashIn,
    cashOutPaisa: cashOut,
    expectedCashPaisa: openingFloatPaisa + cashSales + Number(received.cash) + cashIn - cashOut - Number(refunds.cash) - Number(supplierPaid.cash),
  };
}

/** The terminal this request came from, or why there is none. */
async function requireTerminal(principal: Principal) {
  if (!principal.terminalId) return null;
  const [terminal] = await db.select().from(terminals)
    .where(and(eq(terminals.id, principal.terminalId), eq(terminals.businessId, principal.businessId!), eq(terminals.active, true))).limit(1);
  return terminal ?? null;
}

async function loadShift(businessId: string, id: string) {
  const [row] = await db.select().from(shifts).where(and(eq(shifts.businessId, businessId), eq(shifts.id, id))).limit(1);
  return row ?? null;
}

/** A cashier works on their own shift; seeing or changing someone else's needs shifts.view_all. */
const mayUse = (principal: Principal, shift: typeof shifts.$inferSelect) =>
  shift.openedBy === getActorId(principal) || hasPermission(principal, "shifts.view_all");

shiftsRoutes.get("/shifts/current", requirePermission("shifts.open"), async (context) => {
  const principal = getPrincipal(context);
  if (!principal.terminalId) return apiError(context, 400, "TERMINAL_REQUIRED", "Open the POS on a registered terminal");
  const [row] = await db.select().from(shifts)
    .where(and(eq(shifts.businessId, principal.businessId!), eq(shifts.terminalId, principal.terminalId), eq(shifts.status, "open"))).limit(1);
  return context.json(row ? shiftView(row, false) : null);
});

shiftsRoutes.post("/shifts/open", requirePermission("shifts.open"), idempotent(), validateJson(openShiftSchema), async (context) => {
  const principal = getPrincipal(context);
  const terminal = await requireTerminal(principal);
  if (!terminal) return apiError(context, 400, "TERMINAL_REQUIRED", "Open the POS on a registered terminal");
  const actor = getActorId(principal);
  const { openingFloatPaisa } = context.req.valid("json");
  const [created] = await db.insert(shifts).values({
    businessId: terminal.businessId, branchId: terminal.branchId, terminalId: terminal.id, openedBy: actor,
    openingFloatPaisa, createdBy: actor, updatedBy: actor,
  }).onConflictDoNothing().returning();
  if (!created) return apiError(context, 409, "SHIFT_ALREADY_OPEN", "This terminal already has an open shift. Close it first.");
  await auditPrincipal(context, principal, "shift", created.id, "open", null, { openingFloatPaisa });
  return context.json(shiftView(created, false), 201);
});

shiftsRoutes.post("/shifts/:id/cash-movements", requirePermission("cash.movement"), idempotent(), validateJson(cashMovementSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const shift = await loadShift(businessId, paramId(context));
  if (!shift || !mayUse(principal, shift)) return apiError(context, 404, "NOT_FOUND", "Shift not found");
  const input = context.req.valid("json");
  try {
    const [created] = await db.insert(cashMovements).values({ businessId, shiftId: shift.id, ...input, createdBy: getActorId(principal) }).returning();
    await auditPrincipal(context, principal, "cash_movement", created.id, input.kind, null, { shiftId: shift.id, amountPaisa: input.amountPaisa, reason: input.reason });
    return context.json(created, 201);
  } catch (error) {
    if (String((error as { cause?: Error }).cause?.message ?? error).includes("SHIFT_NOT_OPEN")) {
      return apiError(context, 409, "SHIFT_NOT_OPEN", "This shift is closed");
    }
    throw error;
  }
});

shiftsRoutes.post("/shifts/:id/close", requirePermission("shifts.close"), idempotent(), validateJson(closeShiftSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  const actor = getActorId(principal);
  const outcome = await db.transaction(async (tx) => {
    // FOR UPDATE waits for sales being posted (they hold FOR SHARE) and blocks new ones, so the expected cash is final.
    const [shift] = await tx.select().from(shifts).where(and(eq(shifts.businessId, businessId), eq(shifts.id, paramId(context)))).for("update");
    if (!shift || !mayUse(principal, shift)) return "missing" as const;
    if (shift.status === "closed") return "closed" as const;
    const summary = await summarise(tx, businessId, shift.id, shift.openingFloatPaisa);
    const [closed] = await tx.update(shifts).set({
      status: "closed", closedBy: actor, closedAt: new Date(), countedPaisa: input.countedPaisa, countedBreakdown: input.countedBreakdown ?? null,
      expectedPaisa: summary.expectedCashPaisa, variancePaisa: input.countedPaisa - summary.expectedCashPaisa, note: input.note, updatedBy: actor, updatedAt: new Date(),
    }).where(eq(shifts.id, shift.id)).returning();
    return { closed, summary };
  });
  if (outcome === "missing") return apiError(context, 404, "NOT_FOUND", "Shift not found");
  if (outcome === "closed") return apiError(context, 409, "SHIFT_NOT_OPEN", "This shift is already closed");
  await auditPrincipal(context, principal, "shift", outcome.closed.id, "close", null, {
    countedPaisa: outcome.closed.countedPaisa, expectedPaisa: outcome.closed.expectedPaisa, variancePaisa: outcome.closed.variancePaisa,
  });
  return context.json({ shift: shiftView(outcome.closed, true), report: outcome.summary });
});

/** X report while the shift is open (expected cash only for people who may see it), Z report once closed. */
shiftsRoutes.get("/shifts/:id/report", requirePermission("shifts.open"), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const shift = await loadShift(businessId, paramId(context));
  if (!shift || !mayUse(principal, shift)) return apiError(context, 404, "NOT_FOUND", "Shift not found");
  const summary = await summarise(db, businessId, shift.id, shift.openingFloatPaisa);
  const showExpected = shift.status === "closed" || hasPermission(principal, "shifts.view_all");
  const { expectedCashPaisa, ...rest } = summary;
  return context.json({
    kind: shift.status === "closed" ? "Z" : "X",
    shift: shiftView(shift, showExpected),
    report: showExpected ? { ...rest, expectedCashPaisa } : rest,
  });
});

shiftsRoutes.get("/shifts", requirePermission("shifts.view_all"), async (context) => {
  const principal = getPrincipal(context);
  const page = Math.max(1, Math.trunc(Number(context.req.query("page") ?? 1)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(context.req.query("pageSize") ?? 25)) || 25));
  const where = eq(shifts.businessId, principal.businessId!);
  const rows = await db.select().from(shifts).where(where).orderBy(desc(shifts.openedAt)).limit(pageSize).offset((page - 1) * pageSize);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(shifts).where(where);
  return context.json({ data: rows.map((row) => shiftView(row, true)), page, pageSize, total });
});
