import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { expenseCategorySchema, expenseSchema, reverseExpenseSchema } from "../../../shared/schemas/accounts";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { conflictOrThrow } from "../../lib/dbErrors";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { apiError, paramId } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { getActorId, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";
import { mapAccountError } from "../accounts/routes";
import { escapeLike } from "../products/service";
import { resolveBranchId } from "../sales/location";

// Expenses (FR-CSH-05): money spent, from an account or from the register. Immutable once recorded; a mistake is reversed.

export const expenseRoutes = new Hono();

const view = requirePermission("expenses.view");
const create = requirePermission("expenses.create");
const paisa = (value: unknown) => Number(value);
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const dateParam = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
const uuidParam = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
const pageOf = (query: (name: string) => string | undefined) => ({
  page: Math.max(1, Math.trunc(Number(query("page") ?? 1)) || 1),
  pageSize: Math.min(100, Math.max(1, Math.trunc(Number(query("pageSize") ?? 25)) || 25)),
});

// ---------------------------------------------------------------- categories

expenseRoutes.get("/expense-categories", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const rows = await db.execute(sql`select id, name, active from expense_categories where business_id = ${businessId} order by active desc, lower(name)`);
  return context.json({ data: rows.map((row) => ({ id: String(row.id), name: String(row.name), active: Boolean(row.active) })) });
});

expenseRoutes.post("/expense-categories", create, validateJson(expenseCategorySchema), async (context) => {
  const principal = getPrincipal(context);
  const input = context.req.valid("json");
  const actor = getActorId(principal);
  try {
    const [row] = await db.execute(sql`insert into expense_categories (business_id, name, active, created_by, updated_by) values (${principal.businessId!}, ${input.name}, ${input.active}, ${actor}, ${actor}) returning id, name, active`);
    await auditPrincipal(context, principal, "expense_category", String(row.id), "create", null, { name: input.name });
    return context.json({ id: String(row.id), name: String(row.name), active: Boolean(row.active) }, 201);
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

expenseRoutes.put("/expense-categories/:id", create, validateJson(expenseCategorySchema), async (context) => {
  const principal = getPrincipal(context);
  const id = paramId(context);
  const input = context.req.valid("json");
  try {
    const [row] = await db.execute(sql`update expense_categories set name = ${input.name}, active = ${input.active}, updated_by = ${getActorId(principal)}, updated_at = now() where id = ${id} and business_id = ${principal.businessId!} returning id, name, active`);
    if (!row) return apiError(context, 404, "NOT_FOUND", "Category not found");
    await auditPrincipal(context, principal, "expense_category", id, "update", null, { name: input.name, active: input.active });
    return context.json({ id: String(row.id), name: String(row.name), active: Boolean(row.active) });
  } catch (error) {
    return conflictOrThrow(context, error);
  }
});

// ---------------------------------------------------------------- expenses

async function loadExpense(businessId: string, id: string) {
  const [row] = await db.execute(sql`
    select e.*, c.name as category_name, a.name as account_name, b.name as branch_name, u.display_name as created_by_name, r.display_name as reversed_by_name
    from expenses e join expense_categories c on c.id = e.category_id join branches b on b.id = e.branch_id
    left join accounts a on a.id = e.account_id left join users u on u.id = e.created_by left join users r on r.id = e.reversed_by
    where e.business_id = ${businessId} and e.id = ${id}`);
  return row ? expenseOf(row) : null;
}

const expenseOf = (row: Record<string, unknown>) => ({
  id: String(row.id), number: String(row.number), expenseDate: day(row.expense_date), amountPaisa: paisa(row.amount_paisa),
  categoryId: String(row.category_id), categoryName: String(row.category_name), paidFrom: String(row.paid_from),
  accountId: row.account_id ? String(row.account_id) : null, accountName: row.account_name ? String(row.account_name) : null, shiftId: row.shift_id ? String(row.shift_id) : null,
  branchName: row.branch_name ? String(row.branch_name) : "", payee: String(row.payee), reference: String(row.reference), note: String(row.note),
  hasAttachment: Boolean(row.attachment_path), attachmentName: row.attachment_name ? String(row.attachment_name) : null,
  reversed: Boolean(row.reversed_at), reversedAt: iso(row.reversed_at), reversalReason: row.reversal_reason ? String(row.reversal_reason) : null,
  createdAt: iso(row.created_at), createdByName: row.created_by_name ? String(row.created_by_name) : null,
});

expenseRoutes.get("/expenses", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const { page, pageSize } = pageOf((name) => context.req.query(name));
  const from = dateParam(context.req.query("from"));
  const to = dateParam(context.req.query("to"));
  const categoryId = uuidParam(context.req.query("categoryId"));
  const accountId = uuidParam(context.req.query("accountId"));
  const search = context.req.query("q")?.trim();
  const includeReversed = context.req.query("reversed") !== "hide";
  const filters = [sql`e.business_id = ${businessId}`];
  if (from) filters.push(sql`e.expense_date >= ${from}::date`);
  if (to) filters.push(sql`e.expense_date <= ${to}::date`);
  if (categoryId) filters.push(sql`e.category_id = ${categoryId}`);
  if (accountId) filters.push(sql`e.account_id = ${accountId}`);
  if (!includeReversed) filters.push(sql`e.reversed_at is null`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    filters.push(sql`(e.number ilike ${pattern} or e.payee ilike ${pattern} or e.reference ilike ${pattern} or e.note ilike ${pattern})`);
  }
  const where = sql.join(filters, sql` and `);
  const rows = await db.execute(sql`
    select e.*, c.name as category_name, a.name as account_name, count(*) over () as total
    from expenses e join expense_categories c on c.id = e.category_id left join accounts a on a.id = e.account_id
    where ${where} order by e.expense_date desc, e.number desc limit ${pageSize} offset ${(page - 1) * pageSize}`);
  // What was spent in the filtered range (reversed ones do not count), for the total under the list.
  const [sum] = await db.execute(sql`select coalesce(sum(e.amount_paisa) filter (where e.reversed_at is null), 0)::bigint as total from expenses e where ${where}`);
  return context.json({ data: rows.map(expenseOf), page, pageSize, total: rows.length ? paisa(rows[0].total) : 0, spentPaisa: paisa(sum.total) });
});

expenseRoutes.get("/expenses/:id", view, async (context) => {
  const found = await loadExpense(getPrincipal(context).businessId!, paramId(context));
  return found ? context.json(found) : apiError(context, 404, "NOT_FOUND", "Expense not found");
});

expenseRoutes.post("/expenses", create, idempotent(), validateJson(expenseSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const input = context.req.valid("json");
  // The branch is the shift's when paid from the register, else the one named or the till's.
  let branchId: string | null = null;
  if (input.shiftId) {
    const [shift] = await db.execute<{ branch_id: string }>(sql`select branch_id from shifts where id = ${input.shiftId} and business_id = ${businessId}`);
    branchId = shift?.branch_id ?? null;
  } else {
    branchId = await resolveBranchId(businessId, input.branchId, principal.terminalId);
  }
  if (!branchId) return apiError(context, 422, input.shiftId ? "SHIFT_NOT_OPEN" : "INVALID_BRANCH", input.shiftId ? "That shift was not found" : "This branch is not available");
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`select post_expense(${JSON.stringify({
        business_id: businessId, branch_id: branchId, category_id: input.categoryId, amount_paisa: input.amountPaisa, expense_date: input.expenseDate, paid_from: input.paidFrom,
        account_id: input.accountId, shift_id: input.shiftId, payee: input.payee, reference: input.reference, note: input.note,
      })}::jsonb, ${getActorId(principal)}) as id`);
      return row.id;
    });
  } catch (error) {
    const mapped = mapAccountError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "expense", id, "create", null, { amountPaisa: input.amountPaisa, paidFrom: input.paidFrom });
  return context.json(await loadExpense(businessId, id), 201);
});

expenseRoutes.post("/expenses/:id/reverse", create, idempotent(), validateJson(reverseExpenseSchema), async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const input = context.req.valid("json");
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select reverse_expense(${businessId}::uuid, ${id}::uuid, ${input.reason}, ${input.shiftId ?? null}::uuid, ${getActorId(principal)})`);
    });
  } catch (error) {
    const mapped = mapAccountError(context, error);
    if (mapped) return mapped;
    throw error;
  }
  await auditPrincipal(context, principal, "expense", id, "reverse", null, { reason: input.reason });
  return context.json(await loadExpense(businessId, id));
});

// ---------------------------------------------------------------- the bill's photo or PDF

const bucket = "expense-attachments";
const maxBytes = 5 * 1024 * 1024;
const types: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

/** Attaches (or replaces) the photo or PDF of the bill. The file goes to private storage; the expense records only where. */
expenseRoutes.post("/expenses/:id/attachment", create, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const id = paramId(context);
  const [expense] = await db.execute<{ attachment_path: string | null; reversed_at: string | null }>(sql`select attachment_path, reversed_at from expenses where id = ${id} and business_id = ${businessId}`);
  if (!expense) return apiError(context, 404, "NOT_FOUND", "Expense not found");
  if (expense.reversed_at) return apiError(context, 409, "ALREADY_REVERSED", "A reversed expense cannot take a new attachment");
  const form = await context.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return apiError(context, 400, "VALIDATION_FAILED", "Choose a photo or a PDF of the bill");
  const extension = types[file.type];
  if (!extension) return apiError(context, 400, "VALIDATION_FAILED", "The bill must be a photo (JPEG, PNG, WebP) or a PDF");
  if (file.size === 0 || file.size > maxBytes) return apiError(context, 413, "FILE_TOO_LARGE", "The bill must be less than 5 MB");
  const path = `${businessId}/${id}/${randomUUID()}.${extension}`;
  const uploaded = await supabaseAdmin.storage.from(bucket).upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });
  if (uploaded.error) {
    console.error("Expense attachment upload failed", uploaded.error);
    return apiError(context, 502, "STORAGE_UNAVAILABLE", "The file could not be stored. Try again in a moment.");
  }
  await db.execute(sql`update expenses set attachment_path = ${path}, attachment_name = ${file.name.slice(0, 200)} where id = ${id} and business_id = ${businessId}`);
  // The old file, if there was one, is no use any more.
  if (expense.attachment_path) await supabaseAdmin.storage.from(bucket).remove([expense.attachment_path]).catch(() => undefined);
  await auditPrincipal(context, principal, "expense", id, "attach", null, { name: file.name, bytes: file.size });
  return context.json(await loadExpense(businessId, id), 201);
});

/** A link to the bill that works for five minutes. The file itself is never public. */
expenseRoutes.get("/expenses/:id/attachment", view, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const [expense] = await db.execute<{ attachment_path: string | null; attachment_name: string | null }>(sql`select attachment_path, attachment_name from expenses where id = ${paramId(context)} and business_id = ${businessId}`);
  if (!expense?.attachment_path) return apiError(context, 404, "NOT_FOUND", "This expense has no attachment");
  const signed = await supabaseAdmin.storage.from(bucket).createSignedUrl(expense.attachment_path, 300);
  if (signed.error || !signed.data) return apiError(context, 502, "STORAGE_UNAVAILABLE", "The file could not be opened. Try again in a moment.");
  return context.json({ url: signed.data.signedUrl, name: expense.attachment_name, expiresInSeconds: 300 });
});
