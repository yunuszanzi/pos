// Fingerprints a database so a restore can be checked against what it was restored from (v1.0, acceptance test 2).
//
//   node scripts/reconcile.mjs --url <postgres url> [--before <ISO time>] [--out file.json]   write the fingerprint
//   node scripts/reconcile.mjs --compare a.json b.json                                         compare two; exit 1 if they differ
//
// The fingerprint holds, per business, the totals an owner would check by hand (sales, payments, stock, what customers owe and what is
// owed to suppliers, account balances, expenses), and, when no --before time is given, the row count and a checksum of every table, so a
// restore of the very same moment can be proven identical row for row. With --before, only the totals are taken, as of that time:
// compare the live database "as of last night's backup" with the restored copy.

import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };

if (args.includes("--compare")) {
  const [a, b] = args.slice(args.indexOf("--compare") + 1);
  const left = JSON.parse(readFileSync(a, "utf8"));
  const right = JSON.parse(readFileSync(b, "utf8"));
  const differences = [];
  const walk = (path, x, y) => {
    if (x && y && typeof x === "object" && typeof y === "object") {
      for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) walk(`${path}${path ? "." : ""}${key}`, x[key], y[key]);
    } else if (x !== y) differences.push(`${path}: ${JSON.stringify(x)} <> ${JSON.stringify(y)}`);
  };
  walk("", left.totals, right.totals);
  if (left.tables && right.tables) walk("tables", left.tables, right.tables);
  if (differences.length) {
    console.error(`DIFFERENT: ${differences.length} difference(s)`);
    for (const line of differences.slice(0, 50)) console.error(`  ${line}`);
    process.exit(1);
  }
  const businesses = Object.keys(left.totals).length;
  console.log(`MATCH: ${businesses} business(es)${left.tables && right.tables ? `, ${Object.keys(left.tables).length} tables identical row for row` : ", totals identical"}`);
  process.exit(0);
}

const url = option("--url") ?? process.env.DATABASE_URL;
if (!url) { console.error("Give --url or set DATABASE_URL"); process.exit(2); }
const before = option("--before");
if (before && Number.isNaN(Date.parse(before))) { console.error("--before must be a date and time, for example 2026-11-09T21:00:00Z"); process.exit(2); }
const cutoff = before ?? "9999-12-31T00:00:00Z";
const sql = postgres(url, { max: 1, prepare: false });

const totals = {};
const ensure = (id) => (totals[id] ??= {});
const rows = (query) => sql.unsafe(query, [cutoff]);

for (const row of await rows(`select business_id, count(*)::int as invoices, coalesce(sum(total_paisa), 0)::text as total, coalesce(sum(tax_paisa), 0)::text as tax, coalesce(sum(paid_paisa - change_paisa), 0)::text as paid, coalesce(sum(balance_paisa), 0)::text as credit
  from sales_invoices where posted_at < $1::timestamptz group by 1`)) Object.assign(ensure(row.business_id), { invoices: row.invoices, salesPaisa: row.total, taxPaisa: row.tax, paidPaisa: row.paid, creditPaisa: row.credit });
for (const row of await rows(`select business_id, count(*)::int as entries, coalesce(sum(qty_base), 0)::text as qty, coalesce(round(sum(qty_base * unit_cost_paisa)), 0)::text as value from stock_ledger where created_at < $1::timestamptz group by 1`))
  Object.assign(ensure(row.business_id), { stockMovements: row.entries, stockQuantity: row.qty, stockMovementValuePaisa: row.value });
for (const row of await rows(`select business_id, party_type, count(*)::int as entries, coalesce(sum(debit_paisa - credit_paisa), 0)::text as balance from party_ledger where entry_at < $1::timestamptz group by 1, 2`))
  Object.assign(ensure(row.business_id), { [`${row.party_type}LedgerEntries`]: row.entries, [`${row.party_type}BalancePaisa`]: row.balance });
for (const row of await rows(`select business_id, count(*)::int as entries, coalesce(sum(amount_paisa), 0)::text as balance from account_entries where created_at < $1::timestamptz group by 1`))
  Object.assign(ensure(row.business_id), { accountEntries: row.entries, accountsPaisa: row.balance });
for (const row of await rows(`select business_id, count(*)::int as expenses, coalesce(sum(amount_paisa), 0)::text as total from expenses where created_at < $1::timestamptz group by 1`))
  Object.assign(ensure(row.business_id), { expenses: row.expenses, expensesPaisa: row.total });
for (const row of await rows(`select business_id, count(*)::int as returns, coalesce(sum(total_paisa), 0)::text as total from sales_returns where posted_at < $1::timestamptz group by 1`))
  Object.assign(ensure(row.business_id), { returns: row.returns, returnsPaisa: row.total });

const fingerprint = { takenAt: new Date().toISOString(), before: before ?? null, totals };
if (!before) {
  fingerprint.tables = {};
  const names = (await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by c.relname`).map((row) => row.relname);
  for (const name of names) {
    const [row] = await sql.unsafe(`select count(*)::int as rows, coalesce(md5(string_agg(t::text, '' order by t::text)), '') as checksum from "${name}" t`);
    fingerprint.tables[name] = { rows: row.rows, checksum: row.checksum };
  }
}
await sql.end();

const out = option("--out");
if (out) writeFileSync(out, JSON.stringify(fingerprint, null, 2));
const businesses = Object.keys(totals).length;
console.log(`${businesses} business(es)${fingerprint.tables ? `, ${Object.keys(fingerprint.tables).length} tables` : `, totals before ${before}`}${out ? ` -> ${out}` : ""}`);
if (!out) console.log(JSON.stringify(fingerprint, null, 2));
