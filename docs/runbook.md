# Operations runbook (v1.0)

For whoever looks after the system. Short, and in the order you will need it.

## What runs where

| Part | Where | Notes |
|---|---|---|
| App and API | Vercel (one function, `api/[[...route]].ts`) | Deploys from `main`; a preview for every pull request |
| Database, sign-in, files | Supabase | Postgres, Auth, Storage (the `expense-attachments` bucket) |
| Scheduled work | An external scheduler calling the job endpoints | Vercel's free plan allows daily cron only (below) |
| Errors and alerts | Sentry and a webhook (both optional) | `SENTRY_DSN`, `ALERT_WEBHOOK_URL` |

## Environment variables (Vercel, production)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`,
`PIN_SESSION_SECRET`, `APP_ENCRYPTION_KEY`, `CRON_SECRET`, and optionally `SENTRY_DSN`, `ALERT_WEBHOOK_URL`.
**`FBR_ADAPTER` must not be set in production** (it switches FBR to a built-in fake). Generate secrets with `openssl rand -base64 32`.
Keep a copy of `APP_ENCRYPTION_KEY` somewhere safe and separate: **if it is lost, every saved FBR token is unreadable** and must be entered again.

## Scheduled jobs

Call each with `Authorization: Bearer $CRON_SECRET` (GET or POST):

| Endpoint | How often | What it does |
|---|---|---|
| `/api/jobs/fbr-retry` | every minute | Sends invoices waiting for FBR; also checks FBR's health |
| `/api/jobs/fbr-sync` | daily | Refreshes FBR's HS codes, units, provinces and sale types |
| `/api/jobs/fbr-health` | every 5 minutes (the retry run already does it) | Raises an alert if more than 5% of the last hour's FBR calls failed |

Any scheduler that can send an HTTP request will do (cron-job.org, GitHub Actions on a schedule, Supabase `pg_cron` with `pg_net`). On a paid Vercel plan the
same can go in `vercel.json` under `crons`. If the retry job stops, invoices stay "FBR pending" and nothing is lost; start it again and they go.

## Backups and restore

Supabase takes daily backups (30-day retention needs the Pro plan; point-in-time recovery, which gives the 15-minute RPO, is an add-on). Check both are on.
Take a manual backup before every release that changes the database.

### The drill (do it before go-live, then every quarter)

1. In Supabase, restore last night's backup into a **new** project (the staging project). Do not restore over production.
2. Fingerprint production **as of the backup time** and the restored copy, and compare:

   ```
   npm run reconcile -- --url "<production url>" --before 2026-11-09T21:00:00Z --out production.json
   npm run reconcile -- --url "<staging url>"    --before 2026-11-09T21:00:00Z --out staging.json
   node scripts/reconcile.mjs --compare production.json staging.json
   ```

   `MATCH` means every business has the same sales, payments, returns, stock movements, customer and supplier balances, account balances and expenses up to that moment.
   Any `DIFFERENT` line names the figure; do not go live until it is explained.
3. Open the staging app, sign in as the owner, open a recent invoice and the stock list, and confirm they look right.
4. Write down the date, who did it, how long the restore took (this is the RTO; the target is 4 hours) and the result.

A rehearsal of the same procedure on the local database (backup, restore into a second database, fingerprint both, compare row by row) is `npm run drill:local`.
It last passed with 83 tables identical row for row. That the comparison catches a missing row, a changed row and a changed total is tested separately (`tests/unit/reconcile.test.ts`).

## When something goes wrong

**Sales are not reaching FBR.** Open the FBR log (`/fbr/log`, filter "Needs attention"). "Refused by FBR" shows FBR's reason; fix the product or customer data and use
"Send to FBR again". "Waiting" with a "next try" time is normal; if nothing is trying, the retry job is not running. Check the scheduler.
**Token refused (UNAUTHORISED).** The owner enters a new token in FBR settings; then resubmit the failed ones from the log.

**A till has sales waiting.** The banner says how many. They send themselves when the connection returns. A sale marked "refused" shows why; fix the cause (for
example a product that was archived) and press "Try again". Nobody should sign out of that device until the banner is clear. After sending, "Offline sales to review" lists any that
went below zero stock or changed price; a manager reads and marks them.

**A migration failed.** Do not edit applied migrations. Restore the pre-release backup into staging, reproduce, and add a new migration that fixes forward.

**Rotating a secret.** `CRON_SECRET`, `PIN_SESSION_SECRET`, the Supabase keys: change in Vercel and redeploy (users will have to sign in again). `APP_ENCRYPTION_KEY`: not a simple change, because
saved FBR tokens are encrypted with it; clear each token, change the key, and have the owner enter the token again.

**A user left.** Deactivate them (Users); history is kept. Change shared PINs.

## Release checklist

1. All of `npm test` and `npm run e2e` pass on the branch (CI does this on every pull request).
2. Take a manual database backup.
3. Merge to `main`; Vercel deploys; migrations are applied with `npm run db:migrate` against production **before** traffic moves to the new code.
4. Smoke test: sign in, make a sale, print it, open the FBR log.
5. Watch Sentry and the FBR log for an hour.

## Dependencies

Monthly: `npm audit --omit=dev`, then update anything high or critical and run the whole suite.
