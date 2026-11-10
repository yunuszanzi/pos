import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { customers, suppliers } from "../../../db/schema";
import { csvToRecords, parseCsv } from "../../../shared/csv";
import { analyseParties, type PartyKind, type PartyLookups } from "../../../shared/partyImport";
import { auditPrincipal } from "../../lib/audit";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { createdByActor, getPrincipal, requirePermission } from "../../lib/permissions";
import { validateJson } from "../../lib/validate";

// Go-live: customers and suppliers loaded from a CSV file, checked row by row with the same rules as the forms, all or nothing.

export const partyImportRoutes = new Hono();

const csvSchema = z.object({ csv: z.string().min(1).max(2_000_000) });
const lower = (text: string) => text.trim().toLowerCase();
const digits = (text: string) => text.replace(/\D/g, "");
type Executor = Pick<typeof db, "select" | "insert">;

async function lookupsFor(executor: Executor, kind: PartyKind, businessId: string): Promise<PartyLookups> {
  if (kind === "supplier") {
    const rows = await executor.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.businessId, businessId));
    return { names: new Set(rows.map((row) => lower(row.name))), cnics: new Set(), namePhones: new Set() };
  }
  const rows = await executor.select({ name: customers.name, phone: customers.phone, cnic: customers.cnic }).from(customers).where(eq(customers.businessId, businessId));
  return {
    names: new Set(), cnics: new Set(rows.flatMap((row) => (row.cnic ? [row.cnic] : []))),
    namePhones: new Set(rows.map((row) => `${lower(row.name)}|${digits(row.phone)}`)),
  };
}

async function analyse(executor: Executor, kind: PartyKind, businessId: string, csv: string) {
  let parsed: ReturnType<typeof csvToRecords>;
  try {
    parsed = csvToRecords(parseCsv(csv));
  } catch (error) {
    return { fileError: error instanceof Error ? error.message : "The file could not be read as CSV" };
  }
  const lookups = await lookupsFor(executor, kind, businessId);
  return { analysis: kind === "customer" ? analyseParties("customer", parsed.headers, parsed.records, lookups) : analyseParties("supplier", parsed.headers, parsed.records, lookups) };
}

function register(kind: PartyKind, base: string, permission: string) {
  const manage = requirePermission(permission);

  partyImportRoutes.post(`${base}/import/preview`, manage, validateJson(csvSchema), async (context) => {
    const checked = await analyse(db, kind, getPrincipal(context).businessId!, context.req.valid("json").csv);
    if ("fileError" in checked) return apiError(context, 400, "INVALID_CSV", checked.fileError);
    return context.json({ canImport: checked.analysis.issues.length === 0, issues: checked.analysis.issues, summary: { rows: checked.analysis.rows.length } });
  });

  /** All or nothing: the file is checked again inside the transaction, so a row added meanwhile cannot slip a duplicate in. */
  partyImportRoutes.post(`${base}/import`, manage, idempotent(), validateJson(csvSchema), async (context) => {
    const principal = getPrincipal(context);
    const businessId = principal.businessId!;
    const outcome = await db.transaction(async (tx) => {
      const checked = await analyse(tx, kind, businessId, context.req.valid("json").csv);
      if ("fileError" in checked) return { fileError: checked.fileError };
      if (checked.analysis.issues.length) return { issues: checked.analysis.issues };
      const rows = checked.analysis.rows.map((entry) => ({ ...entry.input, businessId, ...createdByActor(principal) }));
      for (let at = 0; at < rows.length; at += 500) {
        const chunk = rows.slice(at, at + 500);
        if (kind === "customer") await tx.insert(customers).values(chunk as (typeof customers.$inferInsert)[]);
        else await tx.insert(suppliers).values(chunk as (typeof suppliers.$inferInsert)[]);
      }
      return { imported: rows.length };
    });
    if ("fileError" in outcome) return apiError(context, 400, "INVALID_CSV", outcome.fileError!);
    if ("issues" in outcome) return context.json({ error: { code: "IMPORT_HAS_ERRORS", message: "Fix the listed rows and import again", details: outcome.issues } }, 422);
    await auditPrincipal(context, principal, kind, "import", "import", null, { imported: outcome.imported });
    return context.json({ imported: outcome.imported }, 201);
  });
}

register("customer", "/customers", "customers.manage");
register("supplier", "/suppliers", "suppliers.manage");
