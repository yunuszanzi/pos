# POS System

Foundation release for a browser-based POS and inventory system for Pakistani traders.

## Local setup

1. Install Node.js and the Supabase CLI with Docker available.
2. Copy `.env.example` to `.env` and set the local Supabase URL, anon key, service-role key, database URL, and a random `PIN_SESSION_SECRET` of at least 32 characters. Keep `.env` out of source control.
3. Run `supabase start`, then `npm install`, `npm run db:migrate`, and `npm run db:seed`.
4. Start `npm run dev:api` in one terminal and `npm run dev` in another. Vite proxies `/api` requests to the local Hono server.

The browser uses Supabase Auth for email/password identity and calls the Hono API for business data. Database access and the Supabase service-role key stay server-side.

## Checks

- `npm run typecheck`
- `npm test`
- `npm run e2e`
- `npm run build`

The migration runner applies the ordered SQL files in `db/migrations` transactionally and records them in `app_schema_migrations`. Do not edit an already-applied migration; add a new one instead.

## v0.1 scope

This release includes authentication, owner onboarding, business/branch/location/terminal setup, user and role management, basic settings, document series, and audit history. Product catalogue, inventory operations, sales, printing, and FBR integration belong to later releases.
