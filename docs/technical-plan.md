# POS System — Technical Design & Release Plan

Nov 2, 2026 · @Umair Ali

This plan turns the POS SRS into ten releases (v0.1–v1.0), each deployable on Vercel, usable on its own and covered by its own acceptance tests.

## 1. Tech stack and architecture

One repository, one Vercel project: a React single-page app plus a single API function that holds all business logic and talks to Supabase PostgreSQL. The browser never queries the database directly and never sees FBR credentials.

### 1.1 Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict) across frontend and API | Money, tax and stock logic is shared front and back; types catch unit/amount mix-ups |
| Frontend | React 18 + Vite, React Router | You know React; Vite builds fast and deploys as static files on Vercel |
| UI | Tailwind CSS + shadcn/ui (Radix) | Accessible, keyboard-friendly components; no heavy UI kit to fight |
| Data fetching | TanStack Query | Caching, retries, background refresh of stock and prices |
| Local state | Zustand (POS cart, held sales, terminal settings) | Small, fast, easy to persist to IndexedDB later for offline |
| Forms | React Hook Form + Zod | Same Zod schemas validate on the client and the API |
| API | Vercel Node function running Hono (`/api/[[...route]].ts`) | One function with an internal router stays under Vercel Hobby's function-count limit and keeps cold starts low |
| Database | Supabase PostgreSQL | Chosen in the SRS; managed, cloud, free tier to build |
| ORM / migrations | Drizzle ORM + drizzle-kit | Typed SQL, plain SQL migrations in the repo |
| Posting logic | PostgreSQL functions called in one transaction | Invoice + stock + ledger + payment commit together or not at all |
| Auth | Supabase Auth (email/password) + app roles in our own tables; JWT verified in the API | Free, secure, password reset built in; permissions stay in our control |
| Files | Supabase Storage (logos, product images, expense receipts) | Same project, private buckets with signed URLs |
| Background jobs | Supabase pg\_cron calling the API, or Vercel Cron on Pro | FBR retries, reference-data sync, daily summaries |
| PDF / print | Browser print with print CSS (80 mm, 58 mm, A4, A5); `@react-pdf/renderer` for downloadable PDFs | No desktop install needed |
| Barcodes / QR | `bwip-js` (barcodes), `qrcode` (FBR QR) | Pure JS, works in browser and Node |
| Testing | Vitest, Testing Library, Playwright, Supabase CLI local DB | Unit, integration and end-to-end |
| Monitoring | Sentry (free tier) + Vercel logs | Errors on POS terminals and API |

### 1.2 Request flow

1. The React app loads from Vercel's CDN and the user signs in with Supabase Auth; the app holds a short-lived JWT.
2. Every call goes to `/api/v1/...` with the JWT. Middleware verifies it, loads the user's role, branch and permissions, and rejects anything not allowed.
3. Read endpoints query through Drizzle; write endpoints that post documents call one PostgreSQL function inside a transaction.
4. If FBR is on, the API sends the invoice to FBR right after posting; on failure the invoice is marked pending and a job retries it.

### 1.3 Hosting notes

- Vercel's free Hobby plan is for non-commercial use; a shop running real sales should move to Vercel Pro before go-live. Check Vercel's current plan terms.
- Supabase free projects pause when idle and have no point-in-time recovery; upgrade to Pro before go-live (as noted in the SRS).
- Use the Supabase region nearest Pakistan (e.g. Mumbai or Singapore) and set the Vercel function region to match to keep latency low.

## 2. Repository structure and conventions

A single repo with the frontend, API, shared logic and database side by side, organised by business module so each version adds folders rather than rewriting old ones.

```
pos/
  CLAUDE.md              # instructions for Claude Code (Section 8)
  docs/                  # SRS and this plan, exported as Markdown
  api/[[...route]].ts    # the single Vercel function: mounts the Hono app
  server/
    app.ts               # Hono app, middleware (auth, errors, logging)
    modules/<module>/    # routes.ts, service.ts, schema.ts per module
    fbr/                 # FBR client, payload mappers, retry job
    lib/                 # db client, permissions, numbering, money helpers
  shared/                # code used by both sides
    money.ts             # paisa arithmetic, rounding
    tax.ts, pricing.ts   # line and invoice calculations
    schemas/             # Zod schemas = API contracts
  src/                   # React app
    app/                 # router, layout, providers
    features/<module>/   # pages, components, hooks per module
    pos/                 # POS screen, cart store, keyboard shortcuts
    print/               # receipt and A4 templates, print CSS
    components/ui/       # shadcn components
  db/
    schema/              # Drizzle table definitions
    migrations/          # generated SQL + hand-written SQL functions
    seed.ts              # demo business, users, products
  tests/
    unit/  integration/  e2e/
  supabase/              # Supabase CLI config for local DB
```

Modules: `auth`, `org`, `users`, `products`, `inventory`, `customers`, `suppliers`, `sales`, `returns`, `quotations`, `orders`, `purchasing`, `payments`, `cash`, `expenses`, `reports`, `settings`, `fbr`, `audit`.

Conventions:

- Money is an integer number of paisa everywhere (`amount_paisa`); format only at display, always with exactly 2 decimals (`formatPkr`, and `MoneyInput` for entry). The "amount decimal places" setting is fixed at 2. Costs, average costs and tax round to the whole paisa; rounding a cash total to the nearest 1, 5 or 10 rupees (FR-SAL-16) stays an optional, separate setting
- Quantities are stored in the product's base unit as `numeric(14,3)`, plus the unit and factor used on the line
- IDs are UUIDs; every business table has `business_id`, `created_at`, `created_by`, `updated_at`, `updated_by`
- All calculations (pricing, discounts, tax, totals) live in `shared/` and run identically in the browser (for preview) and in the API (as the source of truth)
- Branch names `v0.x/<feature>`; one pull request per feature; a release tag per version
- Conventional commits (`feat:`, `fix:`, `test:`) so release notes write themselves

## 3. Database design

Balances are never typed in: stock comes from `stock_ledger`, customer and supplier balances from `party_ledger`, cash from `cash_movements`. Cached balance tables exist only for speed and can be rebuilt from the ledgers at any time.

### 3.1 Core tables (by version introduced)

| Table | Key columns | Version |
| --- | --- | --- |
| `businesses` | name, trade\_name, ntn, strn, province, address, logo\_url, settings jsonb | v0.1 |
| `branches`, `locations` | branch\_id, type (store/warehouse/damaged) | v0.1 |
| `terminals` | branch\_id, name, default\_print\_format, fbr\_pos\_id | v0.1 |
| `users`, `roles`, `role_permissions`, `user_branches` | auth\_user\_id, role\_id, pin\_hash, active | v0.1 |
| `document_series` | doc\_type, branch\_id, prefix, next\_number | v0.1 |
| `audit_log` | entity, entity\_id, action, before jsonb, after jsonb, user\_id, terminal\_id | v0.1 |
| `categories`, `brands`, `tax_categories` | tax rate, fbr\_sale\_type | v0.2 |
| `products`, `product_variants` | sku, name, hs\_code, tax\_category\_id, cost\_paisa, track\_batch | v0.2 |
| `units`, `product_units` | factor\_to\_base, barcode, fbr\_uom, sale\_price\_paisa | v0.2 |
| `price_lists`, `price_list_items` | tier, min\_qty, price\_paisa | v0.2 |
| `stock_ledger` | variant\_id, location\_id, qty\_base (±), unit\_cost\_paisa, doc\_type, doc\_id, created\_at | v0.2 |
| `stock_balances` | variant\_id, location\_id, on\_hand, reserved, avg\_cost\_paisa | v0.2 |
| `stock_adjustments` (+`_lines`) | reason, status, approved\_by | v0.2 |
| `shifts`, `cash_movements` | terminal\_id, opening\_float, counted, expected, variance | v0.3 |
| `sales_invoices` (+`_lines`) | number, customer\_id, status, subtotal, discount, tax, total, paid, balance, fbr\_status | v0.3 |
| `payments`, `payment_allocations`, `payment_methods` | method, amount\_paisa, reference, fbr\_payment\_code | v0.3 |
| `held_sales` | terminal\_id, cart jsonb | v0.3 |
| `customers`, `customer_groups`, `areas` | phone, ntn, strn, cnic, registered, price\_list\_id, credit\_limit, terms\_days | v0.4 |
| `party_ledger` | party\_type, party\_id, doc\_type, doc\_id, debit, credit | v0.4 |
| `sales_returns` (+`_lines`) | original\_invoice\_id, original\_line\_id, reason, restock\_to | v0.4 |
| `cheques` | party, bank, due\_date, status | v0.4 |
| `suppliers`, `purchase_orders`, `goods_receipts`, `purchase_invoices`, `purchase_returns` (+`_lines`), `landed_costs` |  | v0.5 |
| `quotations`, `sales_orders`, `delivery_challans` (+`_lines`) | revision, valid\_until, converted\_to | v0.6 |
| `expense_categories`, `expenses`, `accounts` | account type cash/bank/wallet | v0.7 |
| `fbr_config`, `fbr_reference_data`, `fbr_submissions` | env, token (encrypted), payload, response, irn, status, attempts, next\_retry\_at | v0.8 |
| `stock_transfers`, `stock_counts` (+`_lines`), `batches` |  | v0.9 |

### 3.2 Posting rules

- A document is `draft` until posted; posting is one SQL function (e.g. `post_sales_invoice(invoice_id)`) that locks the stock rows it touches (`SELECT … FOR UPDATE`), checks stock and credit limits, writes ledgers, assigns the final number and sets `posted`
- Posted rows are protected by a trigger that rejects `UPDATE`/`DELETE` except the allowed status fields (e.g. `returned_qty`, `fbr_status`)
- Line rows copy price, discount, tax rate, unit factor and current average cost at posting time
- Weighted average cost is recalculated on every stock receipt: `new_avg = (on_hand × avg + qty × cost) / (on_hand + qty)`
- Invoice numbers come from `document_series` inside the posting transaction, so posted numbers have no gaps

### 3.3 Security in the database

- Row-level security on every table keyed by `business_id`, as a second line of defence behind API checks
- The API connects with a server-only role; the browser only uses the Supabase anon key for sign-in
- FBR tokens stored with `pgsodium`/Vault encryption or encrypted in the API with a key held in Vercel env vars

## 4. API design

REST over JSON at `/api/v1`, one resource per module, validated by the shared Zod schemas. Every write that posts a document takes an `Idempotency-Key` header so a double-click or network retry never creates two invoices.

### 4.1 Conventions

- Auth: `Authorization: Bearer <supabase JWT>`; terminal identified by `X-Terminal-Id`
- Permissions declared per route: `requirePermission('sales.create')`; manager override sends `X-Override-Pin` and is logged
- Lists: `?q=&page=&pageSize=&sort=&from=&to=&branchId=`; response `{ data, page, total }`
- Errors: `{ error: { code, message, details } }` with codes like `STOCK_INSUFFICIENT`, `CREDIT_LIMIT_EXCEEDED`, `PERMISSION_DENIED`, `FBR_VALIDATION_FAILED`
- Money in paisa (integers), dates in ISO 8601 with Asia/Karachi offset

### 4.2 Main endpoints

| Module | Endpoints |
| --- | --- |
| Auth / users | `GET /me`, `POST /auth/pin-switch`, `CRUD /users`, `CRUD /roles`, `GET /permissions` |
| Org | `GET/PUT /business`, `CRUD /branches`, `CRUD /locations`, `CRUD /terminals`, `GET/PUT /settings` |
| Products | `CRUD /products`, `GET /products/lookup?barcode=`, `CRUD /categories`, `CRUD /price-lists`, `POST /products/import`, `GET /products/export` |
| Inventory | `GET /stock`, `GET /stock/ledger`, `POST /stock-adjustments`, `POST /stock-adjustments/:id/approve`, `POST /transfers`, `POST /transfers/:id/dispatch`, `POST /transfers/:id/receive`, `POST /stock-counts` |
| POS / sales | `POST /sales` (create + post), `GET /sales/:id`, `GET /sales/:id/print?format=pos80` \| `pos58` \| `a4` \| `a5`, `POST /held-sales`, `DELETE /held-sales/:id` |
| Returns | `GET /sales/:id/returnable`, `POST /returns`, `POST /exchanges` |
| Customers | `CRUD /customers`, `GET /customers/:id/ledger`, `GET /customers/:id/statement`, `POST /customer-payments` |
| Quotes / orders | `CRUD /quotations`, `POST /quotations/:id/convert`, `CRUD /sales-orders`, `POST /delivery-challans` |
| Purchasing | `CRUD /suppliers`, `CRUD /purchase-orders`, `POST /goods-receipts`, `POST /purchase-invoices`, `POST /purchase-returns`, `POST /supplier-payments` |
| Cash | `POST /shifts/open`, `POST /shifts/:id/cash-movement`, `POST /shifts/:id/close`, `GET /shifts/:id/x-report`, `CRUD /expenses` |
| Reports | `GET /reports/:reportKey?filters…`, `GET /dashboard` |
| FBR | `GET/PUT /fbr/config`, `POST /fbr/test`, `POST /fbr/sync-reference`, `GET /fbr/submissions`, `POST /fbr/submissions/:id/retry` |
| Jobs (cron, secret-protected) | `POST /jobs/fbr-retry`, `POST /jobs/fbr-sync`, `POST /jobs/daily-summary` |

### 4.3 Sale request example

```json
POST /api/v1/sales
Idempotency-Key: 6f1c…
{
  "customerId": null,
  "lines": [
    { "variantId": "…", "unitId": "carton", "qty": 2, "unitPricePaisa": 450000, "discountPaisa": 0 }
  ],
  "invoiceDiscount": { "type": "percent", "value": 5 },
  "payments": [ { "method": "cash", "amountPaisa": 900000 } ],
  "print": { "format": "pos80", "copies": 1 }
}
```

The API recalculates every amount from the shared pricing code and rejects the request if the client totals differ, so a tampered browser cannot change prices.

### 4.4 API naming: every call says what it does

Every API operation has one descriptive verb-first name, used identically for the frontend client function, the server handler and the route's operation ID. Anyone reading `getAllProducts()` in a component knows exactly what it fetches without opening the API.

Rules:

- Verb first, then the thing: `get`, `getAll`, `search`, `create`, `update`, `archive`, `post` (for financial posting), `approve`, `convert`, `send`, `sync`
- Singular for one record (`getProductById`), plural for lists (`getAllProducts`), `By…` for the lookup key (`getProductByBarcode`), `…Since` for delta syncs
- No generic names (`fetchData`, `getItems`, `submit`, `handleApi`); no abbreviations
- One file per module in `src/api/` (`productsApi.ts`) exports the named functions; components never call `fetch` directly

| Function name | HTTP route | Does |
| --- | --- | --- |
| `getAppBootstrapData` | `GET /bootstrap` | Everything the app needs after login, in one call (5.7) |
| `getDataVersions` | `GET /data-versions` | Change counters per cached dataset, to know what to refresh |
| `getAllProducts` | `GET /products` | Paged product list for the back office |
| `getProductChangesSince` | `GET /products/changes?since=` | Products added/changed/archived since the last sync |
| `getProductByBarcode` | `GET /products/lookup?barcode=` | Fallback only, when a barcode isn't in the local cache |
| `createProduct` / `updateProduct` / `archiveProduct` | `POST/PUT/DELETE /products` | Maintain products |
| `getStockLevelsForProducts` | `POST /stock/levels` | Stock for a batch of product IDs in one call |
| `postSaleInvoice` | `POST /sales` | Post a sale and return print data |
| `getSaleInvoiceById` | `GET /sales/:id` | One invoice with lines and payments |
| `getReturnableLinesForInvoice` | `GET /sales/:id/returnable` | Lines and quantities still returnable |
| `postSalesReturn` | `POST /returns` | Post a return / credit note |
| `getCustomerChangesSince` | `GET /customers/changes?since=` | Delta sync of customers |
| `getCustomerLedger` | `GET /customers/:id/ledger` | Khata history and balance |
| `postCustomerPayment` | `POST /customer-payments` | Receive payment and allocate |
| `convertQuotationToInvoice` | `POST /quotations/:id/convert` | Turn a quote into an invoice |
| `openShift` / `closeShift` | `POST /shifts/open`, `/shifts/:id/close` | Cash register sessions |
| `submitInvoiceToFbr` / `retryFbrSubmission` | `POST /fbr/...` | FBR posting and retry |

All other endpoints in 4.2 follow the same pattern.

## 5. Key technical designs

These pieces carry most of the risk and the speed; each is designed once here and reused by every module.

### 5.1 Sale posting

1. Client builds the cart with `shared/pricing.ts` and shows live totals.
2. `POST /sales` validates with Zod, recalculates totals server-side, checks the idempotency key.
3. One transaction calls `post_sales_invoice`: lock stock rows → check availability (unless negative stock allowed) → check customer credit limit → insert invoice + lines → insert `stock_ledger` rows (negative qty) → update `stock_balances` → insert payments and allocations → write `party_ledger` for any unpaid balance → take the next number → set `posted`.
4. After commit: write audit entry; if FBR is on, enqueue and immediately attempt submission (Section 5.4).
5. Return the invoice with print data; the client prints in the chosen format.

Returns, purchases, transfers and adjustments follow the same pattern with their own SQL function.

### 5.2 Pricing, discount and tax engine (`shared/`)

- Price resolution order: customer-specific price → customer's price list (with quantity breaks) → product unit price
- Line: `gross = qty × unit_price`; line discount; then share of invoice discount allocated by line value; then tax per line from its tax category (inclusive or exclusive per setting)
- Rounding: round per line to the paisa, round the invoice total per the cash-rounding setting, show the rounding line
- Pure functions with exhaustive unit tests (table-driven cases for every tax mode and discount type)

### 5.3 Printing

- One React print component per document, four layouts: `pos80`, `pos58`, `a4`, `a5`, chosen by the selector (SRS FR-PRT-00) with a per-terminal default saved in `terminals.default_print_format`
- Rendered into a hidden iframe with `@page { size: 80mm auto; margin: 0 }` (or `A4`) and `window.print()`; works with any printer Windows/Android can see
- PDF download and WhatsApp share use the same data rendered by `@react-pdf/renderer` (A4/A5) and a slip-width PDF for POS format
- Reprints call the same endpoint with `reprint=true`; the API logs it and the layout shows "DUPLICATE"
- Optional later: ESC/POS via WebUSB/Web Serial for silent printing and cash-drawer kick

### 5.4 FBR client (`server/fbr/`)

- `FbrClient` interface with two adapters: `DigitalInvoicingAdapter` (PRAL DI API) and `PosFiscalAdapter` (FBR POS integration); a `MockAdapter` for local development and tests
- `mapInvoiceToFbr(invoice)` builds the payload from stored HS codes, FBR UoM, rates, sale types and buyer details; validated locally before sending
- Every attempt is a row in `fbr_submissions` (payload, response, status, attempts, next\_retry\_at); the local invoice ID is the idempotency reference so FBR never receives the same invoice twice
- Retry: exponential back-off (1, 5, 15, 60 min, then hourly up to 72 h), run by the cron job; failures past the limit raise a dashboard alert
- Returned IRN/fiscal number and QR data are written to the invoice; reprint shows them
- Base URLs, token and environment come from `fbr_config`; nothing FBR-specific is hard-coded

### 5.5 Offline POS (v0.9)

- Service worker caches the app; catalogue, prices, customers and settings sync to IndexedDB on login and every few minutes
- When offline, sales are saved locally with a terminal-reserved number block (e.g. `T3-OFF-000001…`) and printed with "to be synced"
- On reconnection a sync queue posts them in order with their original timestamps and idempotency keys; conflicts (stock gone negative, price changed) are posted and flagged for review rather than rejected
- Credit sales above limit, returns and FBR fiscalisation wait until online

### 5.6 Permissions

- Permission keys like `sales.create`, `sales.discount.above_limit`, `reports.profit.view`; roles are sets of keys stored in the DB
- The API enforces them on every route; the React app reads the same list to hide buttons (convenience only)

### 5.7 Efficient data loading and caching

The app loads shared data once, keeps it in React Context and IndexedDB, and only calls the API for data that changes per transaction. Target: after the POS screen has loaded, scanning and selling 50 items makes **zero** API calls until Pay, and Pay makes **one** (`postSaleInvoice`, whose response already contains the print data).

What lives where:

| Data | Stored in | Loaded by | Refreshed when |
| --- | --- | --- | --- |
| Business, branch, terminal, settings, print defaults | `AppDataContext` + IndexedDB | `getAppBootstrapData` at login | `getDataVersions` shows a change |
| User, role, permission keys | `AuthContext` + IndexedDB | `getAppBootstrapData` | Login, or permissions version changes |
| Tax categories, payment methods, units, categories, brands, price lists | `AppDataContext` + IndexedDB | `getAppBootstrapData` | Version change |
| Product catalogue (SKUs, barcodes, units, prices) | IndexedDB, read through a `useProductCatalog` hook | First full load, then `getProductChangesSince` | Version change, or every 5 min while open |
| Customers (name, phone, tier, credit limit, balance) | IndexedDB | `getCustomerChangesSince` | Version change, after each credit sale/payment from the response |
| Stock levels | TanStack Query cache, short-lived | `getStockLevelsForProducts` in one batch | When the POS opens and with the 5-minute check; the server re-checks stock on posting anyway |
| Cart, held sales | Zustand store (persisted) | — | Never fetched |
| Reports, ledgers, document lists | TanStack Query, not persisted | On demand | Only when the user opens or filters them |

Rules for every screen:

- **One bootstrap call** after login instead of a dozen setup calls; datasets carry a version number so unchanged data is never re-downloaded
- **Version check, not polling everything:** `getDataVersions` is a tiny call (on app focus and every 5 minutes) that returns counters; only datasets whose counter changed are refreshed, and only their delta
- **Local first lookups:** barcode scan, product search, customer search, price-tier and tax calculation all run against local data; `getProductByBarcode` is a fallback for a barcode not found locally
- **Responses update the cache:** after a create/update/post, the returned record is written into the cache; no follow-up "get" call
- **No refetch noise:** TanStack Query with long `staleTime` for master data, `refetchOnWindowFocus` off except where needed, request de-duplication by query key
- **Batch and debounce:** batch endpoints for many IDs, 300 ms debounce on server-side searches in the back office, abort stale requests when the user keeps typing, pagination on every list
- **Context only for slow-changing data:** split contexts (`AuthContext`, `AppDataContext`, `TerminalContext`) so a change in one doesn't re-render the whole app; fast-changing state (cart) stays in Zustand
- **Never cached locally:** FBR tokens, other users' data, profit/cost fields for users without permission, CNICs; the cache is scoped to business + user and wiped on logout
- **Measured:** a dev-only network counter in the POS footer and a Playwright test that asserts the call counts above, so regressions are caught in CI

This cache is built in v0.3 and is the same store the offline mode (5.5) extends in v0.9.

## 6. Release plan

The shop can start selling on v0.3; every later version adds a module on top without breaking the earlier ones. Each version ends with its acceptance tests passing in CI, a deploy to staging, a short manual walkthrough, then a release tag and production deploy.

&#91;embedded content: release roadmap · 11 versions in 3 phases\]

Menu rule for every version: a module whose page is not built yet appears in the menu as "Under development" and cannot be clicked (`src/app/plannedModules.ts`); the version that builds it removes that entry and adds the route.

Definition of done for every version: migrations applied cleanly on a fresh and an existing database, unit + integration tests green, the listed Playwright end-to-end tests green, seed data updated, release notes written, docs updated.

### v0.1 Foundation

Scope: repo, CI, Vercel + Supabase projects (staging, production), Supabase Auth, users, roles and permission matrix, business profile, branches, locations, terminals, document series, settings shell, audit log, app layout. SRS: FR-USR-01–06, FR-ORG-01–04, FR-AUD-01.

Acceptance tests:

1. Owner signs up, creates the business, a branch, a terminal and a cashier user.
2. Cashier signs in and cannot open Users or Settings, in the UI or by calling the API.
3. PIN switch changes the active user on a terminal; audit log shows both logins.

### v0.2 Catalogue and stock

Scope: categories, brands, tax categories, products, variants, multiple units with conversion, barcodes, price lists and quantity breaks, CSV import/export, opening stock, stock ledger and balances, stock adjustments with approval, barcode label printing. SRS: FR-PRD-01–10, FR-INV-01–03, 06, 09, 10.

Acceptance tests:

1. Import 500 products from CSV with a preview of errors; fix and re-import.
2. Product with piece/pack/carton units: opening stock of 10 cartons shows as 2,000 pieces.
3. Adjustment above threshold stays pending until a manager approves; ledger and balance update only after approval.

#### As built in v0.2

Decisions taken while building, where they add to or differ from the text above:

- **SKUs and units.** Every product has at least one variant (the SKU). Stock is kept per SKU in its base unit as `numeric(14,3)`. In the API a quantity is a string (`"200"`, `"-2.5"`); in code it is an integer number of thousandths (`shared/units.ts`) and never goes through a float. A conversion that does not give a whole thousandth of a base unit is rejected.
- **Reorder levels** are per SKU, not per SKU and location (FR-PRD-08). Per-location levels come with transfers in v0.9.
- **Ledger and balances.** `stock_ledger` is append-only (trigger). `stock_balances` is written only by a trigger on the ledger, so it cannot drift. Posting order is the ledger's `seq` column (migration 0003), because `created_at` is the transaction start time and ties within a transaction. The weighted-average formula in 3.2 runs in that trigger on every receipt; `shared/stockLedger.ts` applies the same rule in code to value stock as of a past date and to cross-check the cached balances.
- **Adjustments.** `post_stock_adjustment` (SQL) locks the balance rows, refuses negative stock and writes the ledger in the caller's transaction. The approval threshold is a business setting (`adjustment_approval_threshold_paisa`, default PKR 10,000). A user with `inventory.approve` posts their own adjustments at once; anyone else waits when the value is over the threshold. Reason `opening` is only available through the opening-stock import.
- **Idempotency.** The `idempotency_keys` table and the `idempotent()` middleware arrive in v0.2 and are used by adjustments, approvals, product import and opening stock. The `Idempotency-Key` header is required, a successful response is stored and replayed, the same key with a different body is a 422, and a failed attempt releases the key.
- **CSV import.** One validator (`shared/productImport.ts`) serves both the preview and the commit, and any error blocks the whole file. One row per SKU; rows with the same product name become variants of one product. On an existing SKU a blank cell means "leave unchanged", so exporting and re-importing changes nothing and a user without cost access cannot wipe costs. A new SKU joins an existing product only when a row for one of that product's existing SKUs is in the same file. The base unit of an existing product cannot be changed by import, nor after stock has moved. Exports neutralise cells a spreadsheet would run as formulas.
- **Costs.** `products.cost.view` hides cost, average cost and value in lists, the ledger, valuation and exports, and blocks setting costs through an import or a form. Audit entries for product and stock changes include cost fields, so anyone with `audit.view` can see them.
- **Valuation** replays the ledger up to the end of the chosen day (Asia/Karachi). Sale value always uses today's sale prices, because prices are not versioned yet (FR-PRD-13).
- **Label printing** (5.3 is followed for receipts, not for labels). Labels print from a separate root that is hidden on screen and is the only thing shown to the printer, so the app around it adds no blank pages. Barcodes use `bwip-js` (tree-shaken `ean13` and `code128`) and are drawn as images, never inserted as markup.
- **Permissions added:** `catalog.view`, `catalog.manage`, `products.cost.view`, `products.import`, `products.export`, `inventory.view`, `inventory.adjust`, `inventory.approve`, `inventory.opening_stock`. Defaults for the system roles live in `shared/permissions.ts` and are used by both business setup and migration 0002.
- **Endpoints added (4.2):** `/categories`, `/brands`, `/tax-categories`, `/units`, `/price-lists`, `/products` (with `/lookup`, `/export`, `/import/preview`, `/import`), `/stock`, `/stock/levels`, `/stock/ledger`, `/stock/valuation`, `/stock/opening` (and `/preview`), `/stock-adjustments` (with `/:id/approve` and `/:id/reject`).

Not built in v0.2, with the requirement it touches: the FIFO costing setting (FR-INV-06; weighted average is built), an image upload and an attribute editor in the product form (FR-PRD-01, FR-PRD-02; the fields exist and import/export keep them), per-location reorder levels (FR-PRD-08), and applying a price list to a sale (v0.3 and v0.4). Reserved stock exists as a column and is always zero until sales orders in v0.6.

### v0.3 POS sales (first usable release)

Scope: POS screen (scan, search, grid, units, qty, line and invoice discount, walk-in customer), tax calculation, hold/recall, cash/card/wallet/bank and split payments, sale posting, gap-free numbering, receipts with the format selector (POS 80/58 mm, A4, A5), reprint with DUPLICATE, shifts with open/close, X/Z report, keyboard shortcuts, daily sales report, bootstrap data load and local catalogue cache (5.7), with a test that selling 50 scanned items makes one API call. SRS: FR-SAL-01–07, 09–11, 16, FR-PRT-00–07, FR-CSH-01–04.

Acceptance tests:

1. Scan 5 items, apply 5% bill discount, split cash + JazzCash, print 80 mm slip: totals, tax and change are correct.
2. Reprint the same sale as A4: identical totals, marked DUPLICATE, logged.
3. Two terminals sell the last unit at the same moment with negative stock off: exactly one succeeds.
4. Close shift with a cash count; Z-report shows expected vs counted and variance.
5. Double-clicking Pay creates one invoice, not two.

#### As built in v0.3

Decisions taken while building, where they add to or differ from the text above:

- **Who works out the bill.** The browser shows a live total from `shared/pricing.ts`, but `POST /sales` looks up every price, unit factor and tax rate itself and prices the cart again with the same code; the amounts in the request are only the cashier's `expectedTotalPaisa`, and a difference is a 409 `TOTAL_CHANGED`. `post_sales_invoice` (migration 0005) then checks the lines add up to the invoice, locks stock rows in a fixed order, refuses to sell below zero unless the business allows it, takes the gap-free number last, and writes invoice, lines, payments and ledger together.
- **Stock refusals** are 409 `STOCK_INSUFFICIENT` with a message that names the product and the base-unit numbers.
- **Discounts and prices.** A discount needs `sales.discount`; above the role's `max_discount_bps` it needs a manager's email and PIN sent with the sale (checked and rate-limited like `/auth/manager-override`), and the invoice stores `approved_by`. A price different from the shelf price needs `sales.price_override`. Customers, credit and price tiers are v0.4, so every sale is a walk-in paid in full and no price list is applied yet.
- **Payments.** Only cash can be over-tendered (`shared/payments.ts`). A payment row stores the amount applied to the bill, the amount tendered and the change, so shift cash is the sum of applied cash.
- **Idempotency at the till.** The cart store keeps one checkout key until the cart changes, so a second press of Pay, or a retry after a lost reply, repeats the same sale. If a retry's body differs the server answers 422 `IDEMPOTENCY_KEY_REUSED` and the till takes a new key.
- **Terminal on the request.** A valid `X-Terminal-Id` (business and branch checked) now sets the principal's terminal, not only a PIN session. Shifts and sales belong to that terminal; where a terminal sells from is `terminals.sales_location_id`, else the branch's oldest active store location (`server/modules/sales/location.ts`), and bootstrap returns the resolved id.
- **Shifts.** One open shift per terminal. Closing locks the shift row (sales hold it `FOR SHARE`), so expected cash is final: opening float + cash sales + cash in − cash out. The expected figure and variance are hidden from the cashier until the count is saved (blind count) unless they hold `shifts.view_all`. A closed shift cannot change.
- **Bootstrap and sync (5.7).** `GET /pos/bootstrap` returns everything but the catalogue; `GET /pos/data-versions` is the cheap check (on focus and every 5 minutes); `GET /pos/products/changes?since=N` returns products changed after a version, archived ones included, costs only for roles with `products.cost.view`, and a page always ends on a whole version. The till stores products in IndexedDB per business and user (`pos-cache:<business>:<user>`), saves each page before asking for the next, and builds an in-memory index so scans and search never call the server. Signing out wipes the cache and the cart. Stock is fetched once when the catalogue is ready and at each version check for up to 500 stocked SKUs; after a sale the response updates it.
- **Held sales** are rows on the server, per terminal (50 at most). Recall returns the cart and deletes it in one statement. A recalled cart is shape-checked before use.
- **Printing.** `shared/receipt.ts` builds one model for every format and the format only sets the paper (`@page`) and layout. The first print of a sale is the original (automatic if `auto_print_receipt`); any later print calls `POST /sales/:id/reprint`, which numbers the copy, writes the audit log, and the paper carries "DUPLICATE — copy N, not the original". Receipts print from a root hidden on screen, like labels.
- **Reports.** `GET /reports/daily-sales` is one Asia/Karachi day; cost and profit only for `products.cost.view`. Shift X/Z reports are `GET /shifts/:id/report`.
- **Permissions used:** `sales.create`, `sales.discount`, `sales.discount.above_limit`, `sales.price_override`, `sales.reprint`, `sales.void`, `shifts.open`, `shifts.close`, `shifts.view_all`, `cash.movement`, `reports.sales.view` (added in migration 0005 with role defaults).
- **Endpoints added (4.2):** `/sales` (list, `/:id`, `/:id/reprint`), `/shifts` (`/current`, `/open`, `/:id/close`, `/:id/cash-movements`, `/:id/report`), `/held-sales` (`/:id/recall`), `/pos/bootstrap`, `/pos/data-versions`, `/pos/products/changes`, `/reports/daily-sales`.

Acceptance tests 1, 2, 4 and 5 run in Playwright against the real stack (`tests/e2e/pos.spec.ts`), together with a test that 50 scans make no API call and Pay makes one. Test 3 (two terminals, last unit) runs at the API level (`tests/integration/sales-api.test.ts`); the 80 mm slip is verified by what is sent to `window.print`, not on a physical printer.

Not built in v0.3, with the requirement it touches: applying a price list or customer tier to a sale and credit sales (FR-SAL-03, 08; v0.4); the `getProductByBarcode` fallback for a barcode missing from the local catalogue (the whole catalogue is local, so a miss means the product is not sold); stock for more than 500 SKUs at once; keeping bootstrap data in IndexedDB (needed with offline mode, v0.9); a screen for browsing past shifts (the API lists them); and the hand walkthrough with a real 80 mm printer and barcode scanner that ends the version (technical-plan 8.4).

### v0.4 Customers, credit and returns

Scope: customers, groups, areas, price tier per customer, credit limit and terms, credit sales (khata), customer ledger, receive payments with allocation, statements (PDF/WhatsApp), ageing, cheques, returns (full/partial, with or without receipt), exchanges, refunds to cash/khata/store credit, credit note print. SRS: FR-SAL-03, 08, FR-CUS-01–09, FR-RET-01–09 (FBR part in v0.8).

Acceptance tests:

1. Wholesale customer gets their tier price automatically; credit sale over limit is blocked until manager PIN.
2. Partial return of 3 of 10 cartons restocks 3 cartons, reverses discount and tax proportionally, reduces khata balance.
3. Customer statement for a month equals invoices − returns − payments.

#### As built in v0.4 (customers, tiers, credit, khata, returns, statements, ageing, opening balances and cheques)

- **Customers** (migration 0006). `customers` carry a credit limit (0 means no credit) and payment terms; a group or the customer itself carries a price list. A named customer buys at that tier on the server (`tierPrice` in `shared/priceLists.ts`); the till resolves the same price locally from the customer's list, which it fetches once per tier. CNIC is for `customers.manage` only and never reaches the till's cache.
- **Khata** (migration 0007). `party_ledger` is append-only: a customer's balance is debit minus credit, positive when they owe us, negative when we hold store credit for them (there is no separate wallet). `customers.balance_paisa` is a cache written only by the ledger trigger (a guard trigger refuses any other change), so it can always be rebuilt from the ledger. A sale to a named customer writes the whole invoice as a debit and what was paid at the counter as a credit, so a statement reads invoices minus payments.
- **Credit sales.** `post_sales_invoice` accepts an unpaid balance only for a named customer. It locks the customer row first, then refuses when balance plus the new debt passes the credit limit (`CREDIT_LIMIT_EXCEEDED`) or an open invoice is older than the customer's terms (`CUSTOMER_OVERDUE`). Two tills selling to the same customer queue on that lock, so the second sees the first one's debt. A manager's email and PIN (`sales.credit_override`) lets the sale through; the API verifies the manager, the database decides whether the approval was needed, and only then records `approved_by` and the note on the invoice.
- **Payments received.** `post_customer_payment` locks the customer, takes the next `receipt` number (the series is created on first use per branch), writes `customer_payments`, allocates to `payment_allocations` (oldest invoice first, or the invoices chosen) and credits the ledger. Money not allocated stays on the account. An invoice's outstanding amount is its unpaid-at-sale balance minus its allocations (`customer_open_invoices`); the next slice's credit notes allocate to invoices the same way (`source_type = 'sales_return'`). Cash needs an open shift on the terminal and counts in that shift's expected cash; other methods can be taken from the back office. The X/Z reports show credit sales and money received.
- **Endpoints added:** `GET /customers/:id/ledger` (balance, open invoices, entries with running balance, paginated), `POST /customer-payments` (Idempotency-Key), `GET /customer-payments/:id`. `POST /sales` takes zero or fewer payments than the total for a named customer. Permissions added: `customers.ledger`, `customers.receive_payment`, `sales.credit_override`; without `customers.ledger` a person sees no balances, and the till shows none.
- **Till.** The payment dialog lets a named customer leave the rest on account ("Put it all on account"), shows their balance, limit and the balance after the sale, and asks for a manager when the server refuses the credit. The customer's new balance comes back with the sale and updates the till's local list. "Customer payment" takes money at the till; the back office has a khata page per customer. Receipts show the customer and their balance; payment receipts print in the four formats like every other document.

- **Returns** (migration 0008). `sales_returns` and `sales_return_lines` are posted documents like invoices (immutable; the only change after posting is `returned_qty_base` on the invoice line). `post_sales_return` locks the customer, then the invoice lines it returns against, and refuses more than was sold (`RETURN_EXCEEDS_SOLD`) or a return worked out from stale figures (`RETURN_CHANGED`: the API sends the returned quantity it read, so two tills returning the same line cannot both succeed). Credit notes use the branch's `return` document series (made at setup as `<invoice prefix>-R`).
- **What a return gives back** (`shared/returns.ts`, unit-tested). The same share of price, line discount, share of the bill discount and tax, rounded on the running total returned, not per return, so any number of partial returns add up to exactly what was sold. The bill's cash rounding is shared out by value returned. Returning all that is left of a line gives back exactly what is left (no thousandth stays behind). The till previews the value with the same function the server uses.
- **Where the money goes.** What the customer still owes on the original invoice is settled first (a `payment_allocations` row with `source_type = 'sales_return'`), and is never paid out. The rest is handed back by cash or any payment method, or kept on the customer's account, where it is store credit (a negative balance the next credit sale uses; no credit limit is needed to spend it). A walk-in can only be refunded by cash or a payment method. The ledger gets a "Return" credit for the whole return and a "Refunded" debit for what was paid out, so a statement reads invoices − returns − payments. A cash refund comes out of the open shift: expected cash goes down by it, and the X/Z report shows returns and cash refunded.
- **Where the goods go.** Per line: back on the shelf (the till's sales location), the branch's damaged location (made on first use), or thrown away (no stock movement). Stock comes back at the cost it left at, so the average is not distorted.
- **Approvals.** A return after `business_settings.return_window_days` (default 14) or with no receipt needs a manager's PIN (`sales.return_override`); the approver and the reason are stored on the credit note. A no-receipt return is priced at today's shelf price and tax. Cashiers hold `sales.return` (the Return button and the list); managers and owners also hold `sales.return_override`.
- **Endpoints added:** `GET /sales/:id/returnable`, `POST /returns` (Idempotency-Key), `GET /returns` (paginated, searchable), `GET /returns/:id`, `POST /returns/:id/reprint` (logged, DUPLICATE). The credit note prints in all four formats (`buildCreditNoteReceipt`).
- **Exchange.** An exchange is a return followed by a new sale at the till. There is no single combined ticket yet: leave the value on the customer's account, or take it as a refund, and sell the new items. Folding the two into one document is left for when FBR credit notes (v0.8) need to refer to the sale they were exchanged for.

- **Statements** (`GET /customers/:id/statement?from=&to=`, `customers.ledger`). Days are the business time zone's days (yyyy-mm-dd, default this month so far). The response has the balance at the start, every entry in the period with the balance after it, and a summary from `summariseStatement` in `shared/khata.ts`: closing = opening + invoices − payments − returns + refunds + other (opening balances and adjustments). Payments are both money paid at the till and payments received later. Not paginated, because a statement prints whole; more than 2,000 entries is refused (`STATEMENT_TOO_LONG`). A statement is a printable document like the others (`buildStatementReceipt`: 80/58 mm slip, A4, A5); the screen also offers a wa.me link.
- **Ageing** (`GET /customer-ageing`, paginated, `?overdue=true`, `?areaId=`, `?q=`). Ageing is read from the ledger, not from invoices (`ageLedger`): a credit pays the oldest debt first, a debit first uses up any credit the customer was holding (so a return that was refunded does not look like new debt), and what remains unpaid is aged by the entry that made it: 0–30, 31–60, 61–90, over 90 days. Owed minus credit always equals the balance. A customer is overdue when the oldest unpaid debt is older than their payment terms (30 days when they have none). This is separate from the per-invoice allocations that decide what a payment settles (`customer_open_invoices`): choosing to settle a newer invoice first does not change the ageing, which stays oldest-first.
- **Opening balances** (migration 0009, `POST /customers-opening-balances/preview` and `POST /customers-opening-balances`, needs `customers.manage` and `customers.ledger`, Idempotency-Key). A CSV of `customer, phone, balance, date, note`; a customer is matched by phone (surer) or by name, and a name shared by two customers must be given with a phone. Positive owes, negative is credit held. All or nothing, checked again inside the transaction. `post_opening_balances` writes `opening_balance` ledger entries dated that day (start of day in the business time zone, never in the future), and refuses any customer who already has a ledger entry: it is a starting point, and later changes are payments or adjustments. The date is what ages the debt. Opening balances are not tied to an invoice, so a payment reduces them through the oldest-first ageing but does not allocate to an invoice.
- **WhatsApp.** `whatsappLink` builds a wa.me link with the message ready; the person presses send. Nothing is sent from the server and no WhatsApp API is used. Numbers are normalised to Pakistan's country code (0300-1234567, +92 300 1234567 and 300 1234567 all become 923001234567). Offered on the khata page, the ageing rows and the statement.
- **Pages:** `/customers/:id/statement`, `/customer-ageing` (menu: Customer ageing), `/customers/opening-balances` (linked from Customers).

- **Cheques** (migration 0010). A cheque is money received, so taking one (`POST /cheques`, `customers.receive_payment`, Idempotency-Key) records an ordinary customer payment at once with the `cheque` payment method (made on first use) and settles the oldest invoices; a post-dated cheque is treated the same, which means the khata (and the credit limit) already counts it. The `cheques` row then moves received → deposited → cleared (`POST /cheques/:id/deposit|clear`, `customers.cheques`: Owner and Manager), or to bounced from received or deposited (`/bounce`, a reason is required). A bounce takes the payment back with new rows only: a negative `payment_allocations` row per invoice the payment had settled (source `cheque_bounce`) so those invoices are open again, and a `cheque_bounce` debit on the ledger. A statement counts it as a payment reversed. The same bank and cheque number cannot be entered twice. A cheque is "due" once the date written on it (business time zone) has come and it is still in hand. `GET /cheques` is paginated (status, `due=true`, search); the `/cheques` page lists them, and the khata page has "Receive a cheque". Not built: bounce charges, a cheque deposit slip, and allocating a cheque to chosen invoices (always oldest first).

### v0.5 Suppliers and purchasing

Scope: suppliers, purchase orders, goods receipts (partial), purchase invoices with landed cost, purchase returns, supplier payments and ledger, payables ageing, weighted average cost updates, reorder list → draft POs. SRS: FR-PUR-01–09, FR-INV-08.

Acceptance tests:

1. PO for 100 units, receive 60 then 40; PO closes; stock +100.
2. Receipt at a new cost updates average cost exactly per the formula; next sale's profit uses it.
3. Supplier ledger and payables ageing match bills minus payments and returns.

### v0.6 Quotations, orders and delivery

Scope: quotations with revisions and statuses, convert to order or invoice, sales orders with stock reservation, delivery challans, A4 tax invoices with buyer NTN/STRN, payment terms and due dates, WhatsApp/email sharing for all documents. SRS: FR-QUO-01–06, FR-SO-01–04, 06, FR-PRT-07.

Acceptance tests:

1. Quotation → accepted → converted to invoice keeps quoted prices even after a price change.
2. Sales order reserves stock (available drops, on-hand doesn't) until dispatched.
3. Quote PDF shared via WhatsApp link opens on a phone.

### v0.7 Reports, dashboard and expenses

Scope: dashboard, full report catalogue (SRS 7.2), Excel/PDF export, profit visibility by permission, expenses with attachments, accounts (cash/bank/wallet), day-end closing, sales tax summary. SRS: FR-RPT-01–04, FR-CSH-05–07, FR-TAX-05.

Acceptance tests:

1. Dashboard totals for a seeded day match the sales register report.
2. Cashier cannot see profit columns in any report or export.
3. Profit and loss = sales − cost of goods sold − expenses for the seeded month.

### v0.8 FBR integration

Scope: FBR settings (Owner only), encrypted token storage, sandbox/production switch, test connection, reference data sync, HS code/UoM/rate/payment mapping, local pre-validation, real-time submission of sales and returns, retry queue, FBR log screen, FBR fields and QR on all print formats, reconciliation report, sandbox scenario runner. Digital Invoicing adapter first, POS fiscal adapter second. SRS: FR-FBR-01–18, FR-PRT-04, FR-RET-08.

Acceptance tests:

1. With the sandbox, a sale is accepted and the slip and A4 both print the FBR number and QR.
2. With FBR unreachable, the sale completes as "FBR pending" and is accepted automatically after FBR returns, with no duplicate.
3. A partial return is accepted as a credit note referencing the original FBR number.
4. A product missing its HS code is blocked before sending, with a clear message.

### v0.9 Advanced inventory and offline

Scope: stock transfers with in-transit, stock counts with variance posting, damaged location, batch/expiry (optional per product), offline POS (Section 5.5), optional silent printing. SRS: FR-INV-04, 05, 11, 12, NFR-AVL-03.

Acceptance tests:

1. Transfer 20 cartons: source drops on dispatch, destination rises on receipt, in-transit shows between.
2. Unplug the network, make 10 sales, reconnect: all 10 sync in order, none duplicated, FBR submits them.

### v1.0 Hardening and go-live

Scope: security review (OWASP checklist, RLS tests), performance tests at SRS targets, backups and restore drill, data import tools for go-live (customers, suppliers, opening balances, stock), Sentry alerts, user guide, move to paid Vercel/Supabase plans, production FBR switch-on.

Acceptance tests:

1. Product search returns in under 300 ms with 20,000 SKUs; sale posts in under 1.5 s.
2. Restore last night's backup into staging and reconcile totals.
3. Every SRS "M" requirement is ticked against a test or a walkthrough.

### v1.1 SGA Balloons customisation

Balloon attributes (size, colour, finish, print), carton/pack setup, SGA price tiers, delivery areas across Karachi, SGA print templates and data migration. Scoped once SGA's needs are confirmed.

## 7. Testing, environments and deployment

Every pull request gets automatic tests and its own Vercel preview link; only tagged releases reach production.

### 7.1 Test layers

| Layer | Tool | What it covers | Runs |
| --- | --- | --- | --- |
| Unit | Vitest | `shared/` money, pricing, tax, unit conversion, numbering; FBR payload mapping | Every commit |
| Integration | Vitest + local Supabase (Docker via Supabase CLI) | API routes and SQL posting functions against a real Postgres: stock, ledgers, permissions, RLS, concurrency | Every PR |
| End-to-end | Playwright | Each version's acceptance tests in a browser, including print previews | Every PR (smoke) and before release (full) |
| FBR | MockAdapter in CI; PRAL sandbox on staging | Payloads, retries, credit notes | PR (mock), release (sandbox) |
| Manual | Walkthrough checklist per version | Real printer, scanner, phone screen | Before each release |

Targets: ≥ 80% coverage of `shared/` and posting functions; every bug fixed gets a test.

### 7.2 Environments

| Environment | Frontend/API | Database | FBR |
| --- | --- | --- | --- |
| Local | `vercel dev` or Vite + local Hono | Supabase CLI (Docker) | Mock |
| Preview | Vercel preview per PR | Supabase staging project | Mock |
| Staging | Vercel `staging` branch | Supabase staging project | PRAL sandbox |
| Production | Vercel `main` | Supabase production project | PRAL production (per business setting) |

### 7.3 Environment variables

`SUPABASE_URL`, `SUPABASE_ANON_KEY` (browser), `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` (server only), `APP_ENCRYPTION_KEY` (FBR tokens), `CRON_SECRET`, `SENTRY_DSN`. FBR tokens are per business and live encrypted in the database, not in env vars.

### 7.4 CI/CD (GitHub Actions + Vercel)

1. On PR: install → lint → type-check → unit tests → start local Supabase → apply migrations → integration tests → Playwright smoke.
2. Vercel builds a preview link for the PR.
3. On merge to `staging`: run migrations on the staging database, deploy, run full Playwright + FBR sandbox suite.
4. On release tag: back up production, run migrations, deploy `main`, run smoke tests; roll back by redeploying the previous Vercel build (migrations are written to be backward compatible for one version).

### 7.5 Backups and monitoring

- Supabase daily backups (and point-in-time recovery on the paid plan); weekly logical dump to separate storage
- Sentry for frontend and API errors; alert when FBR failure rate passes 5% in an hour or a cron job fails

## 8. Working with Claude Code in VS Code

Claude Code in VS Code does not see this chat, so the two docs become its memory: export them into the repo, add a `CLAUDE.md` that points at them, then build one version at a time with plan → code → test → review.

### 8.1 One-time setup

1. Install the **Claude Code** extension in VS Code (Extensions view, search "Claude Code") and sign in with your Claude account ([setup guide](https://code.claude.com/docs/en/vs-code.md)).
2. Install Node.js LTS, Git, Docker Desktop (for local Supabase), the Supabase CLI and the Vercel CLI.
3. Create an empty GitHub repo `pos`, clone it, open it in VS Code.
4. Export the SRS and this plan as Markdown and save them as `docs/srs.md` and `docs/technical-plan.md`.
5. Create Supabase projects `pos-staging` and `pos-prod`, and a Vercel project linked to the repo.
6. Add `CLAUDE.md` at the repo root (8.2). Claude Code reads it at the start of every session ([how CLAUDE.md works](https://code.claude.com/docs/en/memory.md)).

### 8.2 CLAUDE.md starter

```markdown
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

## Commands
npm run dev | npm test | npm run e2e | npm run db:migrate | npm run db:seed
```

### 8.3 Prompt for each version

Start a new Claude Code session per version (or per feature for big versions) and paste:

```
We are building v0.3 (POS sales) from docs/technical-plan.md section 6.
First read CLAUDE.md, the v0.3 scope, and the SRS requirements it lists.
Give me a plan: files to add/change, migrations, endpoints, UI screens, tests.
Wait for my OK before writing code.
Then implement feature by feature, writing tests as you go, and finish by
running all tests and the v0.3 acceptance tests in Playwright.
```

### 8.4 Working rhythm

- Review the plan before approving it; it is cheaper to fix a plan than code
- Let Claude run tests itself and fix failures; check its diffs in VS Code before committing
- Ask for one feature per session in large versions (e.g. v0.3: POS screen, then payments, then printing, then shifts)
- When a decision changes (new table, new rule), ask Claude to update `CLAUDE.md` and `docs/technical-plan.md` in the same commit so later sessions know
- At the end of a version: run the manual walkthrough with a real printer and scanner, tag the release, deploy
