# Progress log (read first when resuming)

Branch: v1.0/hardening. Newest entry on top.

## 2026-11-11
- State found: uncommitted db/migrations/0032_search_indexes.sql (adds CREATE SCHEMA IF NOT EXISTS extensions so plain Postgres test DBs work)
  and new db/migrations/0034_data_export_permission.sql (data.export permission, already used by server/modules/export and shared/permissions.ts).
- `npm test`: 732 pass, 1 fail: tests/integration/performance.test.ts line 64, delta sync took 3464 ms (limit 3000) while the full suite ran in parallel.
  Suspected load noise; re-running that file alone to confirm.
- TODO: confirm perf test alone, run `npm run e2e`, commit the two migrations (conventional message, v1.0).
- Perf test passes alone (155 s), so the failure was parallel-suite load. `npm test` otherwise green.
- `npm run e2e` started in background (took >10 min); result not yet known. Remember to kill any servers it leaves on :3000/:5173.
- e2e: 59 pass, 2 failed; both fixed and now pass:
  1. day-closing.spec: real bug. ExpenseFormPage defaulted its date to the UTC date, so 00:00-05:00 in Karachi it was yesterday and escaped a closed day. Now uses shared/dates.ts businessToday() (unit-tested).
  2. pos.spec:223: stale test; the "Clear" button became "Cancel sale" (asks why) in 9607fd7. Test updated.
- Known same-pattern leftovers (UTC dates in the browser, not fixed): src/features/quotations/QuotationFormPage.tsx:28 inDays, src/features/reports/ReportPage.tsx:19-24. Consider businessToday() there.
- Next: commit (migrations, date fix, test fix), then a final full `npm test` + `npm run e2e` before saying v1.0 done.
