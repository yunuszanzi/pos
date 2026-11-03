# POS System

Generic POS + inventory for Pakistani traders (first client: SGA Balloons, Karachi).
Specs: docs/srs.md (what) and docs/technical-plan.md (how, versions). Read the relevant
sections before any task. Work only on the version named in the task.

## Stack
React 18 + Vite + TypeScript, Tailwind + shadcn/ui, TanStack Query, Zustand,
React Hook Form + Zod. API: single Vercel function (Hono) at api/[[...route]].ts.
DB: Supabase Postgres via Drizzle; posting logic in SQL functions. Auth: Supabase Auth.

## Rules
- Money is integer paisa. Never use floats for money.
- All pricing/tax/discount math lives in shared/ and is unit-tested.
- Posted documents are immutable; corrections are new documents.
- Every API route checks permissions server-side.
- Every posting write uses a transaction and an Idempotency-Key.
- FBR calls only from server/fbr via the FbrClient interface; use MockAdapter in tests.
- Write tests with every feature; run `npm test` and `npm run e2e` before saying done.
- Small commits, conventional commit messages, one branch per feature.
- API functions are named by what they do, verb first: getAllProducts, getProductByBarcode,
  postSaleInvoice. Never fetchData/getItems. Components call src/api/* functions, never fetch.
- Minimise API calls: shared data comes once from getAppBootstrapData into React Context
  + IndexedDB; catalogue and customers sync by delta; scans/search/pricing run locally;
  write responses update the cache instead of refetching. See technical-plan 5.7.
- Print: every document supports POS slip (80/58 mm) and A4/A5, user-selectable.
- Quantities are exact: numeric(14,3) in the database, strings in the API, integer thousandths in
  code (shared/units.ts). Never parseFloat/Number them.
- Stock changes only through SQL functions that write stock_ledger. stock_balances is maintained by
  a trigger; never write it. Hide costs (lists, ledger, valuation, exports, imports) from roles
  without products.cost.view.
- Path ids go through paramId() so a malformed id is a 404, not a 500. Every list is paginated;
  searches are debounced and abort stale requests.

## Commands
npm run dev | npm test | npm run e2e | npm run db:migrate | npm run db:seed
