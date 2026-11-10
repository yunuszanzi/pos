import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { toCsv } from "../../../shared/csv";
import { auditPrincipal } from "../../lib/audit";
import { db, rawClient } from "../../lib/db";
import { apiError } from "../../lib/http";
import { getPrincipal, requirePermission } from "../../lib/permissions";

// The owner's right to take all their data away at any time (FR-AUD-03): everything the business holds, as one JSON file, or any one
// table as CSV for a spreadsheet. Secrets are left out: the FBR token, PINs, share-link tokens and the machinery that is not the shop's.

export const exportRoutes = new Hono();
const mayExport = requirePermission("data.export");

/** Tables that are not the business's records: bookkeeping, secrets in their own right, and copies of FBR's own lists. */
const skippedTables = new Set(["app_schema_migrations", "idempotency_keys", "alert_log", "auth_sessions", "document_shares", "fbr_reference_data"]);
/** Columns held back, by table. */
const hiddenColumns: Record<string, string[]> = { users: ["pin_hash"], fbr_config: ["token_encrypted"] };

type TableInfo = { name: string; keyColumn: "business_id" | "id" };

/** Every table that carries the business's id (and the business row itself). */
async function exportableTables(): Promise<TableInfo[]> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and column_name in ('business_id', 'id') order by table_name`);
  const byTable = new Map<string, Set<string>>();
  for (const row of rows) byTable.set(row.table_name, (byTable.get(row.table_name) ?? new Set()).add(row.column_name));
  const tables: TableInfo[] = [];
  for (const [name, columns] of byTable) {
    if (skippedTables.has(name)) continue;
    if (columns.has("business_id")) tables.push({ name, keyColumn: "business_id" });
    else if (name === "businesses") tables.push({ name, keyColumn: "id" });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}

const isTableName = (name: string) => /^[a-z_][a-z0-9_]*$/.test(name);
const selectFor = (table: TableInfo) => {
  const hidden = hiddenColumns[table.name] ?? [];
  const removal = hidden.map((column) => ` - '${column}'`).join("");
  return `select to_jsonb(t)${removal} as row from "${table.name}" t where "${table.keyColumn}" = $1`;
};

exportRoutes.get("/export/tables", mayExport, async (context) => {
  const businessId = getPrincipal(context).businessId!;
  const tables = await exportableTables();
  const counts = await Promise.all(tables.map(async (table) => {
    const [row] = await rawClient.unsafe(`select count(*)::int as n from "${table.name}" where "${table.keyColumn}" = $1`, [businessId]);
    return { name: table.name, rows: Number(row.n) };
  }));
  return context.json({ data: counts.filter((entry) => entry.rows > 0) });
});

exportRoutes.get("/export/data", mayExport, async (context) => {
  const principal = getPrincipal(context);
  const businessId = principal.businessId!;
  const tableName = context.req.query("table");
  const format = context.req.query("format") === "csv" ? "csv" : "json";
  const tables = await exportableTables();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    const table = tables.find((entry) => entry.name === tableName);
    if (!tableName || !isTableName(tableName) || !table) return apiError(context, 400, "TABLE_REQUIRED", "Choose which table to export as CSV");
    const rows = (await rawClient.unsafe(selectFor(table), [businessId])).map((row) => row.row as Record<string, unknown>);
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const cell = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
    await auditPrincipal(context, principal, "export", businessId, "export", null, { table: table.name, rows: rows.length, format });
    return new Response(`﻿${toCsv([columns, ...rows.map((row) => columns.map((column) => cell(row[column])))])}`, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${table.name}-${stamp}.csv"` },
    });
  }

  await auditPrincipal(context, principal, "export", businessId, "export", null, { table: "all", format });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      try {
        write(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"businessId":${JSON.stringify(businessId)},"tables":{`);
        let firstTable = true;
        for (const table of tables) {
          write(`${firstTable ? "" : ","}${JSON.stringify(table.name)}:[`);
          firstTable = false;
          let firstRow = true;
          // A cursor reads in batches, so a business with a million rows never sits in memory at once.
          for await (const batch of rawClient.unsafe(selectFor(table), [businessId]).cursor(1000)) {
            write(batch.map((row) => `${JSON.stringify(row.row)}`).join(",").replace(/^/, firstRow ? "" : ","));
            firstRow = false;
          }
          write("]");
        }
        write("}}");
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="business-data-${stamp}.json"` } });
});
