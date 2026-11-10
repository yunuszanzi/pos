# POS System

Foundation release (v0.1) for a browser-based POS and inventory system for Pakistani traders.

## Local setup

1. Install Node.js 22+ and Docker Desktop (it must be running). The Supabase CLI is a dev dependency, so use `npx supabase ...`.
2. `npm install`
3. Start the local database and auth. The first run downloads Docker images and can take several minutes:
   `npx supabase start -x studio,edge-runtime,imgproxy,logflare,vector,supavisor`
4. Copy `.env.example` to `.env`. Take `API_URL`, `ANON_KEY` and `SERVICE_ROLE_KEY` from `npx supabase status -o env`, and set `PIN_SESSION_SECRET` to a random string of at least 32 characters. Keep `.env` out of source control.
5. `npm run db:migrate` then `npm run db:seed`
6. Run `npm run dev:api` in one terminal and `npm run dev` in another. Vite proxies `/api` to the Hono server. Confirmation emails (staff invites, password resets) arrive in Mailpit at http://127.0.0.1:54324.

The browser uses Supabase Auth only for email/password sign-in and calls the Hono API for everything else. Direct table access from the browser is revoked (migration `0001`); the service-role key and database connection stay server-side.

## Checks

- `npm run typecheck` and `npm run lint`
- `npm test` runs unit tests, plus integration tests against the real API and local Supabase when `.env` is set (they are skipped otherwise)
- `npm run e2e` runs the acceptance tests in a browser against the real UI, API and local Supabase (starts the API and Vite itself)
- `npm run build`

The migration runner applies the ordered SQL files in `db/migrations` transactionally and records them in `app_schema_migrations`. Do not edit an already-applied migration; add a new one instead.

## Releases

Release notes are in [docs/release-notes](docs/release-notes). The specs are [docs/srs.md](docs/srs.md) (what) and [docs/technical-plan.md](docs/technical-plan.md) (how, by version, including an "As built" note per finished version).

## v0.2 scope: catalogue and stock

Categories, brands, tax categories and units; products with SKUs, several units per SKU (piece, pack, carton) and barcodes; price lists with quantity breaks; CSV import and export with a preview of every problem; opening stock; an append-only stock ledger with running balances; stock adjustments that wait for approval above a threshold; stock valuation at cost and sale price as of any date; barcode label printing for A4 sheets and label rolls.

Cost prices are visible only to roles with `products.cost.view`. Money is integer paisa and quantities are exact (see `shared/money.ts` and `shared/units.ts`).

## v0.1 scope

Authentication, owner onboarding, business/branch/location/terminal setup, document series, user and role management (permission matrix, PIN switch, manager override), basic settings, and an append-only audit log. Product catalogue, inventory, sales, printing and FBR integration belong to later releases.

Rules enforced by the API and covered by tests: every route checks permissions on the server; nobody can manage a user, or grant a permission, above their own; a deactivated user is locked out but history is kept; tenant data is isolated per business.
