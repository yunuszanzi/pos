import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { suppliers } from "../../../db/schema";
import { ageLedger, type KhataEntry } from "../../../shared/khata";
import { supplierSchema } from "../../../shared/schemas/suppliers";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { conflictOrThrow, dbErrorMessage } from "../../lib/dbErrors";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { createdByActor, getActorId, getPrincipal, hasPermission, requirePermission, updatedByActor, type Principal } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { OpeningBalanceFileError } from "../customers/openingBalances";
import { escapeLike } from "../products/service";
import { analyseSupplierOpeningFile } from "./openingBalances";

// Suppliers, what the shop owes them, and how old it is (FR-PUR-01, FR-PUR-06).

export const suppliersRoutes = new Hono();

const view = requirePermission("suppliers.view");
const manage = requirePermission("suppliers.manage");
const viewLedger = requirePermission("suppliers.ledger");
const paisa = (value: unknown) => Number(value);

type Row = typeof suppliers.$inferSelect;

/** What the shop owes a supplier is for people who may see the ledger. */
const present = (row: Row, principal: Principal) => {
  const { balancePaisa, ...rest } = row;
  return hasPermission(principal, "suppliers.ledger") ? { ...rest, balancePaisa } : rest;
};
const forAudit = (row: Row) => {
  const { balancePaisa, ...rest } = row;
  void balancePaisa;
  return rest;
};

const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

suppliersRoutes.get("/suppliers", view, async (context) => {
  const principal = getPrincipal(context);
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const filters: SQL[] = [eq(suppliers.businessId, principal.businessId!)];
  const active = context.req.query("active") ?? "true";
  if (active !== "all") filters.push(eq(suppliers.active, active !== "false"));
  const search = context.req.query("q")?.trim();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(or(ilike(suppliers.name, pattern), ilike(suppliers.contactPerson, pattern), ilike(suppliers.phone, pattern), ilike(suppliers.whatsapp, pattern))!);
  }
  const where = and(...filters);
  const rows = await db.select().from(suppliers).where(where).orderBy(asc(suppliers.name), asc(suppliers.id)).limit(pageSize).offset((page - 1) * pageSize);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(suppliers).where(where);
  return context.json({ data: rows.map((row) => present(row, principal)), page, pageSize, total });
});

suppliersRoutes.get("/suppliers/:id", view, async (context) => {
  const principal = getPrincipal(context);
  const [row] = await db.select().from(suppliers).where(and(eq(suppliers.id, paramId(context)), eq(suppliers.businessId, principal.businessId!))).limit(1);
  return row ? context.json(present(row, principal)) : apiError(context, 404, "NOT_FOUND", "Supplier not found");
});

suppliersRoutes.post("/suppliers", manage, validateJson(supplierSchema), async (context) => {
  const principal = getPrincipal(context);
  try {
    const [row] = await db.insert(suppliers).values({ ...context.req.valid("json"), businessId: principal.businessId!, ...createdByActor(principal) }).returning();
    await auditPrincipal(context, principal, "supplier", row.id, "create", null, forAudit(row));
    return context.json(present(row, principal), 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

suppliersRoutes.put("/suppliers/:id", manage, validateJson(supplierSchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const input = context.req.valid("json");
  const [before] = await db.select().from(suppliers).where(and(eq(suppliers.id, id), eq(suppliers.businessId, principal.businessId!))).limit(1);
  if (!before) return apiError(context, 404, "NOT_FOUND", "Supplier not found");
  try {
    const [after] = await db.update(suppliers).set({ ...input, active: input.active ?? before.active, ...updatedByActor(principal) })
      .where(and(eq(suppliers.id, id), eq(suppliers.businessId, principal.businessId!))).returning();
    await auditPrincipal(context, principal, "supplier", id, "update", forAudit(before), forAudit(after));
    return context.json(present(after, principal));
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

/** A supplier with a history is never deleted: archiving keeps every bill and ledger row pointing at them. */
suppliersRoutes.delete("/suppliers/:id", manage, async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const [row] = await db.update(suppliers).set({ active: false, ...updatedByActor(principal) })
    .where(and(eq(suppliers.id, id), eq(suppliers.businessId, principal.businessId!))).returning({ id: suppliers.id });
  if (!row) return apiError(context, 404, "NOT_FOUND", "Supplier not found");
  await auditPrincipal(context, principal, "supplier", id, "archive", { active: true }, { active: false });
  return context.json({ id, active: false });
});

// ---------------------------------------------------------------- ledger

/** The supplier's ledger, newest first: what the shop owes after each entry (credit = we owe more, debit = we owe less). */
suppliersRoutes.get("/suppliers/:id/ledger", viewLedger, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const [supplier] = await db.select({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone, whatsapp: suppliers.whatsapp, termsDays: suppliers.termsDays, balancePaisa: suppliers.balancePaisa })
    .from(suppliers).where(and(eq(suppliers.id, paramId(context)), eq(suppliers.businessId, businessId))).limit(1);
  if (!supplier) return apiError(context, 404, "NOT_FOUND", "Supplier not found");
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const entries = await db.execute(sql`
    select * from (
      select l.id, l.seq, l.doc_type, l.doc_id, l.doc_number, l.memo, l.debit_paisa, l.credit_paisa, l.entry_at,
             sum(l.credit_paisa - l.debit_paisa) over (order by l.seq) as balance_after, count(*) over () as total
      from party_ledger l
      where l.business_id = ${businessId} and l.party_type = 'supplier' and l.party_id = ${supplier.id}
    ) x order by seq desc limit ${pageSize} offset ${(page - 1) * pageSize}
  `);
  return context.json({
    supplier,
    entries: entries.map((row) => ({
      id: String(row.id), docType: String(row.doc_type), docId: String(row.doc_id), docNumber: String(row.doc_number), memo: String(row.memo),
      debitPaisa: paisa(row.debit_paisa), creditPaisa: paisa(row.credit_paisa), at: new Date(row.entry_at as string).toISOString(), balanceAfterPaisa: paisa(row.balance_after),
    })),
    page, pageSize, total: entries.length ? paisa(entries[0].total) : 0,
  });
});

/**
 * What the shop owes, by how old each debt is: 0–30, 31–60, 61–90 and over 90 days (FR-PUR-06). Read from the ledger as the
 * customer ageing is, with the sides turned round: a payment settles the oldest debt first. `overdue` means the oldest unpaid
 * debt is older than the supplier's payment terms (30 days when there are none). Paginated; totals cover every match.
 */
suppliersRoutes.get("/supplier-ageing", viewLedger, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const search = context.req.query("q")?.trim();
  const named = search ? sql`and (s.name ilike ${`%${escapeLike(search)}%`} or s.phone ilike ${`%${escapeLike(search)}%`})` : sql``;
  const people = await db.execute(sql`
    select s.id, s.name, s.phone, s.whatsapp, s.terms_days, s.balance_paisa from suppliers s
    where s.business_id = ${businessId} and s.balance_paisa <> 0 ${named}`);
  const ids = people.map((row) => String(row.id));
  const ledger = ids.length ? await db.execute(sql`
    select party_id, doc_type, debit_paisa, credit_paisa, entry_at from party_ledger
    where business_id = ${businessId} and party_type = 'supplier' and party_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    order by party_id, seq`) : [];
  const bySupplier = new Map<string, KhataEntry[]>();
  for (const row of ledger) {
    const list = bySupplier.get(String(row.party_id)) ?? [];
    // ageLedger reads debit as "owes us more"; for a supplier it is the credit that is owed, so the sides swap.
    list.push({ docType: String(row.doc_type), debitPaisa: paisa(row.credit_paisa), creditPaisa: paisa(row.debit_paisa), at: new Date(row.entry_at as string).toISOString() });
    bySupplier.set(String(row.party_id), list);
  }
  const now = new Date();
  let rows = people.map((row) => {
    const ageing = ageLedger(bySupplier.get(String(row.id)) ?? [], now);
    const termsDays = Number(row.terms_days);
    return {
      supplierId: String(row.id), name: String(row.name), phone: String(row.phone), whatsapp: String(row.whatsapp), termsDays, balancePaisa: paisa(row.balance_paisa),
      bandsPaisa: ageing.bandsPaisa, owedPaisa: ageing.owedPaisa, creditPaisa: ageing.creditPaisa, oldestDays: ageing.oldestDays,
      overdue: ageing.owedPaisa > 0 && ageing.oldestDays > (termsDays || 30),
    };
  }).filter((row) => row.owedPaisa > 0);
  if (context.req.query("overdue") === "true") rows = rows.filter((row) => row.overdue);
  rows.sort((a, b) => b.owedPaisa - a.owedPaisa || a.name.localeCompare(b.name));
  const totals = rows.reduce((sum, row) => ({
    bandsPaisa: sum.bandsPaisa.map((value, band) => value + row.bandsPaisa[band]), owedPaisa: sum.owedPaisa + row.owedPaisa,
  }), { bandsPaisa: [0, 0, 0, 0], owedPaisa: 0 });
  return context.json({ data: rows.slice((page - 1) * pageSize, page * pageSize), totals, page, pageSize, total: rows.length });
});

// ---------------------------------------------------------------- opening payables

const csvSchema = z.object({ csv: z.string().min(1).max(2_000_000) });

suppliersRoutes.post("/suppliers-opening-balances/preview", manage, viewLedger, validateJson(csvSchema), async (context) => {
  try {
    const analysis = await analyseSupplierOpeningFile(db, getPrincipal(context).businessId!, context.req.valid("json").csv);
    return context.json({
      canImport: analysis.issues.length === 0, issues: analysis.issues,
      summary: { suppliers: analysis.lines.length, owedPaisa: analysis.owedPaisa, creditPaisa: analysis.creditPaisa },
    });
  } catch (error) {
    if (error instanceof OpeningBalanceFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    throw error;
  }
});

/** All or nothing: the file is checked again inside the transaction. */
suppliersRoutes.post("/suppliers-opening-balances", manage, viewLedger, idempotent(), validateJson(csvSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  try {
    const outcome = await db.transaction(async (tx) => {
      const analysis = await analyseSupplierOpeningFile(tx, businessId, context.req.valid("json").csv);
      if (analysis.issues.length) return { issues: analysis.issues };
      const payload = { business_id: businessId, lines: analysis.lines.map((line) => ({ supplier_id: line.customerId, amount_paisa: line.amountPaisa, as_of: line.asOf, note: line.note })) };
      await tx.execute(sql`select post_supplier_opening_balances(${JSON.stringify(payload)}::jsonb, ${getActorId(principal)})`);
      return { result: { suppliers: analysis.lines.length, owedPaisa: analysis.owedPaisa, creditPaisa: analysis.creditPaisa } };
    });
    if ("issues" in outcome) return context.json({ error: { code: "IMPORT_HAS_ERRORS", message: "Fix the listed rows and import again", details: outcome.issues } }, 422);
    await auditPrincipal(context, principal, "supplier", "opening-balances", "opening_balances", null, outcome.result);
    return context.json(outcome.result, 201);
  } catch (error) {
    if (error instanceof OpeningBalanceFileError) return apiError(context, 400, "INVALID_CSV", error.message);
    if (dbErrorMessage(error).includes("OPENING_BALANCE_EXISTS")) return apiError(context, 409, "OPENING_BALANCE_EXISTS", "A supplier in the file already has entries in their ledger");
    throw error;
  }
});
