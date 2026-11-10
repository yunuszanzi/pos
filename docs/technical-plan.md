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

Not built in v0.2, with the requirement it touches: the FIFO costing setting (FR-INV-06; weighted average is built), an image upload and an attribute editor in the product form (FR-PRD-01, FR-PRD-02; the fields exist and import/export keep them), per-location reorder levels (FR-PRD-08), and applying a price list to a sale (v0.3 and v0.4). Reserved stock exists as a column and is always zero until sales orders in v0.6 (it is maintained from open orders since then).

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

#### As built in v0.5 (suppliers, purchase orders, goods receipts, supplier bills, supplier payments, purchase returns and the reorder list)

- **Suppliers** (migration 0011). `suppliers` mirror customers: name (unique per business), contact, phone, WhatsApp, email, address, NTN/STRN, registration, payment terms in days (0 = due on receipt), notes, archive instead of delete. Permissions: `suppliers.view`, `suppliers.manage`, `suppliers.ledger` (Owner and Manager; cashiers hold none). Without `suppliers.ledger` a person sees no balances.
- **Supplier ledger.** Suppliers use the same append-only `party_ledger` as customers (party type `supplier`), with the debit/credit sense kept: **credit = the shop owes the supplier more** (a bill, an opening payable), **debit = it owes less** (a payment, a return). `suppliers.balance_paisa` is the amount WE owe (positive) or what they owe us (negative, credit held), written only by the ledger trigger (a guard trigger refuses anything else), the reverse sign of a customer's balance. The ledger page shows what the shop owes after each entry.
- **Payables ageing** (`GET /supplier-ageing`, paginated, `?overdue=true`, `?q=`). The same `ageLedger` as customers with the sides swapped: a payment settles the oldest debt first, credit held is kept apart, and the owed amounts and credit always net to the balance. Overdue means the oldest unpaid debt is older than the supplier's terms (30 days when there are none).
- **Opening payables** (`POST /suppliers-opening-balances/preview` and `/suppliers-opening-balances`, needs `suppliers.manage` and `suppliers.ledger`, Idempotency-Key, migration 0011 `post_supplier_opening_balances`). The customer importer generalised (`shared/openingBalanceImport.ts` takes the party: the column is `supplier`): matched by phone or name, positive = owed to the supplier, negative = credit held, dated (never in the future), all or nothing, refused for a supplier who already has a ledger entry.
- **Pages:** `/suppliers`, `/suppliers/new`, `/suppliers/:id`, `/suppliers/:id/ledger`, `/suppliers/opening-payables`, `/supplier-ageing` (menu: Suppliers, Payables ageing).

- **Purchase orders** (migration 0012, `shared/purchasing.ts`). An order has a supplier, a receiving location, an optional expected date and lines: SKU, the unit bought in, quantity and the price of **one bought unit** (a carton), in whole paisa. A line is worth `round(qty x price)`. Status: draft → sent → partly received → received → closed, or cancelled. A draft can be changed (its lines are replaced); a sent order cannot, so to change it cancel and write another. `sent` can be cancelled only while nothing has been received; `partly received` and `received` can be closed by hand. The number comes from the branch's `purchase_order` series (made on first use, `PO-<branch>`) when the draft is created. Order lines only take active **stocked** SKUs (a service or non-stock item has no stock to receive). Endpoints: `GET/POST /purchase-orders`, `GET/PUT /purchase-orders/:id`, `POST /purchase-orders/:id/send|cancel|close` (Idempotency-Key). Permissions: `purchasing.view`, `purchasing.order`, `purchasing.receive` (Owner and Manager).
- **Goods receipts** (`post_goods_receipt`). Posted, immutable (the one allowed change is `billed_base` on a line, which slice 3's bills move). Against an order (sent or partly received) every line names an order line, takes at most what is still to come (`RECEIPT_EXCEEDS_ORDER`) and may carry the price the supplier really charged; the order moves to partly received, or to **received** when every line is complete (receiving 60 then 40 of 100 completes it). Without an order the lines stand alone with their own price. Stock comes in through `stock_ledger` (doc type `goods_receipt`) at the **cost of one base unit** = `round(price / factor)`; the ledger trigger then keeps the weighted average (`new = round((on hand x avg + qty x cost) / (on hand + qty))`, stock below zero counted as none), which `shared/purchasing.ts averageAfterReceipt` mirrors for previews. The next sale's cost is that average. The receipt's own value is `round(qty x price)` per line, which can differ from stock value by sub-paisa rounding. Receipt numbers come from the `goods_receipt` series (`GRN-<branch>`). No payable arises from a receipt: the supplier's bill (slice 3) creates it, so goods can be booked before the bill arrives.
- **Costs stay hidden.** Without `products.cost.view` no response carries a price, a total or an average cost, prices cannot be written (a draft order needs the permission) and a receipt against an order is posted at the order's price whatever is sent; receiving without an order needs the permission.
- **Printing.** An order and a receipt print on an 80 or 58 mm slip, A4 and A5 (`buildPurchaseOrderReceipt`, `buildGoodsReceiptReceipt`); prices and totals are left off for a reader who may not see costs. `PrintJob` became one type over a map of documents.
- **Pages:** `/purchase-orders` (new, change, detail with send / cancel / close / print), `/goods-receipts` (list, detail, `/goods-receipts/new?order=` to receive against an order, without `?order=` for goods with no order). Quantity boxes take digits and one decimal point only.

- **Supplier bills** (migration 0013, `shared/purchaseBills.ts`). A bill is the supplier's invoice for goods **already received**: each line bills some of a goods-receipt line (in the unit it was received in, never more than was received and not yet billed: `BILL_EXCEEDS_RECEIPT`) at the price on the invoice. The bill carries the supplier's own invoice number (unique per supplier, `BILL_EXISTS`), a date, a due date (date + the supplier's terms), freight and other charges, and input tax per line (`FR-PUR-09`: `tax_rate_bps`, `tax_paisa`, recorded for the tax report in v0.7). Total = items + charges + tax; the API works the sums out and `post_purchase_bill` checks them again (`BILL_TOTAL_MISMATCH`). It credits the supplier's ledger with the whole total (`purchase_bill`), so **the payable arises here, not at the receipt**. Posted bills are immutable. All bill endpoints need `purchasing.bill` **and** `products.cost.view`. Endpoints: `GET /purchase-bills`, `GET /purchase-bills/:id`, `POST /purchase-bills` (Idempotency-Key), `GET /billable-receipt-lines?supplierId=`.
- **Landed cost.** Charges are shared across the billed lines **by value** (`allocateByValue`: whole paisa, largest fractions take the spare paisa, so shares add up to the charges exactly; an even split when every line is worth nothing). A line's landed cost is its value plus its share; tax is recoverable and is **not** part of it. Where that differs from what the receipt put the stock in at (`round(qty_base x cost_per_base)`), the difference is spread over the stock **still on hand** (at most the quantity this line billed) through a **cost adjustment** in the stock ledger: a zero-quantity row with `value_delta_paisa`, doc type `cost_adjustment`, whose trigger sets `new_avg = round((on_hand x avg + value) / on_hand)` (never below 0; nothing happens with no stock). Stock already sold keeps the cost it was sold at, so only the held part is corrected: `absorbed = round(delta x min(on hand, billed) / billed)`, recorded on the bill line. The valuation replay (`shared/stockLedger.ts applyEntry`) understands adjustments. Sub-paisa differences can round away when spread over a large quantity.
- **Printing and pages.** A bill prints in the four formats (`buildPurchaseBillReceipt`). Pages: `/purchase-bills`, `/purchase-bills/new` (pick the supplier, tick received goods, copy price, tax and freight; previews cost per piece with freight), `/purchase-bills/:id`.

- **Paying suppliers** (migration 0014). `supplier_payments` mirror customer payments: a method, an amount, a reference, an optional note, and a number from the branch's `supplier_payment` series (`SPY-<branch>`). `post_supplier_payment` locks the supplier, then allocates the money to the supplier's open bills (`supplier_payment_allocations`: **oldest first**, or the bills chosen; `supplier_open_bills` = bill total less everything allocated) and debits the ledger. Money not allocated stays on the account as an **advance** (a negative balance, "credit with them"). **Cash** needs an open shift on the terminal and comes out of that shift's drawer: the shift report gains `supplierPaymentsPaisa` / `supplierPaymentsCashPaisa` and expected cash subtracts the cash; other methods can be paid from the back office. Endpoints: `POST /supplier-payments` (Idempotency-Key; `suppliers.pay` and `suppliers.ledger`), `GET /supplier-payments`, `GET /supplier-payments/:id`, `GET /suppliers/:id/open-bills`. A payment voucher prints in the four formats and can be reprinted from "Payments made".
- **Purchase returns / debit notes** (`post_purchase_return`). A return is started from a **goods receipt** (every line names a receipt line; there is no return without one). It takes at most what was received and not yet returned (`goods_receipt_lines.returned_base`, `RETURN_EXCEEDS_RECEIVED`) and never more than is on hand at the receipt's location (`STOCK_INSUFFICIENT`: goods already sold cannot go back). Stock leaves at the receipt's cost per base unit, so the average cost is not disturbed. The credit is value + input tax per line, defaulting to the **billed** price and tax rate when the goods were billed (else the receipt's price, no tax) and changeable to what the supplier agrees. It debits the supplier's ledger, then settles the supplier's oldest open bills (`source_type = 'purchase_return'`); the rest stays as credit on their account. No cash refund from the supplier is recorded in this version. Needs `purchasing.return` and `products.cost.view`. Endpoints: `GET /goods-receipts/:id/returnable`, `POST /purchase-returns` (Idempotency-Key), `GET /purchase-returns`, `GET /purchase-returns/:id`. Prints as a debit note.
- **Payables reconcile.** The supplier's balance, the payables ageing total and the sum of open bills' outstanding amounts agree, and equal bills − payments − returns (acceptance test 3; opening payables, which are not bills, appear in the first two only).
- **Bills show what settled them:** `outstandingPaisa`, `settledPaisa` and the settling payments/returns.
- **Pages:** the supplier ledger page (open bills, "Pay supplier"), `/supplier-payments` (menu: Payments made), `/purchase-returns`, `/purchase-returns/new?receipt=`, `/purchase-returns/:id`; "Return goods" on a goods receipt.

- **Reorder list** (migration 0015, `GET /reorder-list`, paginated, `purchasing.view`). A SKU is listed when it is active, stocked, has a reorder level above 0 and **on hand + still to come on sent or partly-received orders** is at or below that level (`suggestReorder` in `shared/purchasing.ts`), most short first. The suggestion is the SKU's reorder quantity, else what it takes to get back to the level, in the base unit. Each row carries the supplier it is normally bought from: the one set in `preferred_suppliers`, else the one it last came from. A draft order does not count as ordered until it is sent. Reorder levels are per SKU (per-location levels, FR-PRD-08, are not built); `?locationId=` counts one location's stock only.
- **Draft orders from the list** (`POST /reorder-list/draft-orders`, `purchasing.order` + the cost permission, Idempotency-Key). Chosen lines become one **draft** purchase order per supplier (all or nothing), each line in the SKU's base unit at what it last cost (the billed price when billed, else the receipt's, else the SKU's own cost), to be changed and sent from the orders page. A line can also set its supplier as the usual one (`remember`).
- **What it cost last time** (`GET /purchase-history/:variantId`, FR-PUR-08, cost permission). The last five receipts of the SKU with the price each carried (**the billed price when it was billed**), newest first, and the last cost per base unit. The purchase order form shows it under each item and starts the price from it (a price already typed is kept).
- **Sharing.** The list can be shared on WhatsApp with `wa.me/?text=`, the person choosing who gets it. Low-stock alerts on the dashboard come with the dashboard in v0.7; email is not built.
- **Not built in v0.5:** per-location reorder levels, a purchase return without a goods receipt, a cash refund from a supplier, bounce-style supplier credit notes outside a return, and approval levels on purchase orders.

Acceptance tests (automated): 1 - `purchasing-api.test.ts` (60 then 40 of 100: partly received, received, stock +100) and `purchasing.spec.ts`; 2 - the same file (average cost per the formula, next sale's cost 1,100) and `stockLedger.test.ts`; 3 - `payables-api.test.ts` (ledger = ageing = open bills = bills − payments − returns).

### v0.6 Quotations, orders and delivery

Scope: quotations with revisions and statuses, convert to order or invoice, sales orders with stock reservation, delivery challans, A4 tax invoices with buyer NTN/STRN, payment terms and due dates, WhatsApp/email sharing for all documents. SRS: FR-QUO-01–06, FR-SO-01–04, 06, FR-PRT-07.

Acceptance tests:

1. Quotation → accepted → converted to invoice keeps quoted prices even after a price change.
2. Sales order reserves stock (available drops, on-hand doesn't) until dispatched.
3. Quote PDF shared via WhatsApp link opens on a phone.

#### As built in v0.6 (quotations, sales orders, delivery challans, back-office invoices and sharing by link)

- **Quotations** (migration 0016, `quotations`, `quotation_lines`). A quotation is for a registered customer (quoted at their price tier) or a prospect (a name and phone). It touches neither stock nor any ledger. Amounts are worked out by the server with the same `shared/pricing.ts` the till uses, through one helper (`server/modules/sales/documentPricing.ts`) that orders and invoices reuse, and are stored on the quotation, so a later price change cannot move it. Price changes need `sales.price_override`; discounts follow the role's limit (there is no manager PIN in the back office, so above the limit is refused). Statuses: draft → sent → accepted or rejected; converted when nothing is left unconverted; revised when a newer revision replaced it. **Expired is never stored**: a sent quotation past its `valid_until` (Karachi date) reads as expired and cannot be accepted, sent again or converted; revising it gives it a new date. A sent quotation is locked in the database (a trigger allows only status, the revision link and `converted_base`); a change is a **revision** (same number, next `revision_no`, history kept). Permissions `quotations.view`, `quotations.manage` (Owner and Manager). Pages `/quotations`, `/quotations/new|:id|:id/edit`.
- **Converting a quotation** (FR-QUO-04). `shared/quotations.ts priceConversion` prices the part being converted at the **quoted** unit price and tax rate, with each line discount scaled to the quantity taken and the whole-quote discount shared out by value; taking everything gives exactly the quoted total. `quotation_lines.converted_base` tracks what is used, whether by an order or an invoice. A quotation for a prospect needs a customer chosen at conversion.
- **Sales orders** (migration 0017, `sales_orders`, `sales_order_lines`). An order is for a registered customer, with their PO number, a delivery date and address, written directly (`POST /sales-orders`, priced like a sale) or from a quotation (`POST /quotations/:id/convert-to-order`, whole or part). Taking it is one transaction: it locks the stock rows in a fixed order, refuses an order for more than is **available** (on hand less reserved) unless the business allows negative stock, and numbers it `SO-<branch>`. It is fixed once taken; to change it, cancel and take a new one. `open` → `partly_delivered` → `delivered` (by dispatch) → `closed`; `cancelled` only while nothing has been delivered. Permissions `sales_orders.view|manage`. Pages `/sales-orders`, `/sales-orders/new|:id`.
- **Stock reservation** (FR-SO-01). `stock_balances.reserved` is now maintained, only by triggers on the order tables: after any change to an order line or an order's status it is recomputed from the open orders (`qty_base - delivered_base`, stocked SKUs, the order's location), so it cannot drift. `available = on_hand - reserved` is what the stock list shows. **The till respects it** (migration 0020): a sale may take only on hand less reserved, with a message naming what is held for orders; so do back-office invoices that send goods out.
- **Delivery challans** (migration 0018, `delivery_challans`, `delivery_challan_lines`). Written against an open or partly delivered order for part or all of what is left (less what other pending challans already carry), numbered `DC-<branch>`, with driver, vehicle, route and address. Statuses `pending` → `dispatched` → `delivered`, `returned`, or `cancelled` (pending only). **Stock leaves on dispatch** through the stock ledger (doc type `delivery_challan`) at the average cost, which is kept on the line; the order's `delivered_base` rises and its status follows; a dispatch without enough on the shelf is refused and nothing moves. **Returned** (from dispatched or delivered, a reason is required) puts the goods back at the cost they left at (`delivery_return`), lowers `delivered_base` and the order holds the stock again; it is refused for goods already billed (`DELIVERY_BILLED`, record a sales return). Cancelling or closing an order cancels its pending challans. A challan prints with no prices and a line for the customer's signature. Permissions `delivery.view|manage`. Pages `/delivery-challans`, `/delivery-challans/:id`, and "Write a delivery challan" on the order.
- **Back-office invoices** (migration 0019, `sales_invoices` gains `channel`, `order_id`, `quotation_id`, `terms_days`, `due_date`, `customer_po`, `note` and a snapshot of the buyer's name, NTN, STRN and address; `terminal_id` and `shift_id` become optional for the `back_office` channel only, enforced by a check). Written at a desk for a registered customer **on credit** (`POST /sales-invoices`, `invoices.create`, Idempotency-Key), numbered from the same gap-free `INV-<branch>` series as till sales, posted by `post_back_office_invoice`. Three sources: **an order** (bills only goods already delivered and not yet billed, in whole or part; no stock moves because it already left, and the line cost is the cost the challan took it out at); **a quotation** and **lines entered directly** (the goods leave with the invoice; reserved stock is respected). Payment terms: due on receipt, 7, 15, 30 days or any number to 365, default the customer's own; the due date is the invoice date plus the terms. The whole total is debited on the customer's ledger, so it appears in the khata and is settled by payments received (oldest first). Credit limit and overdue checks are the till's; a person holding `sales.credit_override` stands as the approver and it is recorded on the invoice. It is immutable once posted, and a return at the till against it works as for any invoice. `GET /sales-invoices` lists back-office invoices (open, overdue, paid; paginated), `GET /sales-invoices/:id` adds what is still owing. Permissions `invoices.view|create`. Pages `/invoices`, `/invoices/new|:id`, "Make an invoice" on orders and quotations.
- **Tax invoice** (FR-SO-04). A back-office invoice prints as **TAX INVOICE** when the buyer has an NTN or STRN (otherwise SALES INVOICE), on A4 (the default for desk invoices), A5 or a slip, showing the buyer's registration and address, their PO, the order, the terms and the due date, and no till or cashier line (`buildReceipt`, `backOfficeMeta`). What it shows is the buyer as they were on the day.
- **Sharing by link** (migration 0021, `document_shares`; FR-PRT-07). `POST /document-shares {type, id}` (quotation, sales order, challan or invoice; needs the permission to view that kind) makes an unguessable link: 256 random bits, valid 30 days, reused while it has more than a day left, revocable (`POST /document-shares/revoke`), counted on every opening. `GET /api/public/documents/:token` is the one route that needs no sign-in; an unknown, malformed, revoked or expired token all give the same 404, nothing is cached, and the response never carries costs. The `/d/:token` page shows the document exactly as it prints (the print mapping is shared in `src/pos/documentPrint.ts`), with no menu, readable on a phone, and **"Print or save as PDF"** through the browser's print dialog. On each document the person presses "Share link", then copies it or sends it on WhatsApp (to the customer's own number when there is one).
- **Also changed:** a request with no readable body is answered 400 (it was a 500); `reserved` is shown in the stock list; Playwright waits 15 s for each assertion and 3 minutes for the servers to start.
- **Not built in v0.6:** an email send (links go by WhatsApp or by copying), a PDF file made on the server (the browser makes the PDF), SMS, the order-booker view on a phone (FR-SO-05, could-have), editing a sent quotation or a taken order (revise or cancel), payment taken as the invoice is written (the customer pays later through the khata), per-invoice due dates in customer ageing and the overdue rule (those still use the customer's terms; the invoice shows its own due date), a manager PIN for over-limit discounts on back-office documents, a prospect being invoiced without becoming a customer, delivery of services or non-stock items on a challan (they are billed from the order), and bar-coded challans.

Acceptance tests (automated): 1 - `sales-orders-api.test.ts` (an accepted quotation converted after the price doubled keeps the quoted prices, whole and in parts) and `quotations-api.test.ts`, `quotations.spec.ts`, `sales-orders.spec.ts`; 2 - `sales-orders-api.test.ts` (on hand 100, reserved 30, available 70 and no stock-ledger row until dispatch), `delivery-challans-api.test.ts`, `delivery-challans.spec.ts`, and the till refusing reserved stock; 3 - `document-shares-api.test.ts` and `quotations.spec.ts` (a link opened with no sign-in in a phone-sized browser, no sideways scroll, dead after "Stop sharing"). Back-office invoices: `sales-invoices-api.test.ts`, `invoices.spec.ts`; print layouts: `tests/unit/receipt.test.ts`.

### v0.7 Reports, dashboard and expenses

Scope: dashboard, full report catalogue (SRS 7.2), Excel/PDF export, profit visibility by permission, expenses with attachments, accounts (cash/bank/wallet), day-end closing, sales tax summary. SRS: FR-RPT-01–04, FR-CSH-05–07, FR-TAX-05.

Acceptance tests:

1. Dashboard totals for a seeded day match the sales register report.
2. Cashier cannot see profit columns in any report or export.
3. Profit and loss = sales − cost of goods sold − expenses for the seeded month.

#### As built in v0.7 (accounts and expenses, the report catalogue, the dashboard and day-end closing)

- **Accounts** (migration 0022, `accounts`, `account_entries`; FR-CSH-06). A cash box, bank account or wallet. Its balance is the sum of an **append-only** list of entries and is changed only by that list (a guard trigger refuses anything else, as for the party ledgers). Every non-cash payment method (card, bank transfer, JazzCash, Easypaisa, and any added later) gets its own account automatically, and money taken or paid by that method lands in it by trigger: sales payments, customer payments, supplier payments out, and refunds out. **Cheques are not in an account until they are deposited** (a manual deposit entry); cash is not an account, the drawer is counted per shift. Manual deposits and withdrawals (a cheque cleared, a bank charge, interest) need a note; **transfers** move money between two accounts, or from the register's open shift into an account as a bank deposit (a cash-out on the shift, so its expected cash drops), both sides together or neither (`post_account_transfer`, numbered `TRF-<branch>`). Permissions `accounts.view`, `accounts.manage`. Pages `/accounts`, `/accounts/:id` (a bank book with the running balance).
- **Expenses** (FR-CSH-05). A category (seeded: rent, electricity/gas/water, salaries, transport, repairs, stationery, tea, bank charges, other; the person may add and retire their own), an amount, a date (not in the future), who was paid, a bill or cheque number, and **where it was paid from**: an account (its balance drops) or the register (the open shift pays it as a cash-out, so the shift's expected cash stays right). Numbered `EXP-<branch>`. **Immutable**; a mistake is **reversed once**, with a reason, which puts the money back (an account entry, or a cash-in on an open shift) and leaves both records, the original marked reversed. A **photo or PDF of the bill** goes to a private Supabase Storage bucket (`expense-attachments`, images and PDF, 5 MB, migration 0023); the API checks who may see the expense and hands out a signed link that lasts five minutes. Permissions `expenses.view`, `expenses.create`. Pages `/expenses`, `/expenses/new|:id`.
- **Report catalogue** (SRS 7.2; `server/modules/reports/catalogue.ts`, `shared/reports.ts`). 36 reports as data: **Sales** (daily summary; by product, category, brand, customer, cashier or salesperson, branch, terminal and hour; invoice register; discounts; returns), **Profit** (gross profit by invoice, product, category and customer; profit and loss), **Inventory** (stock on hand, valuation, low stock, dead stock, the stock ledger), **Purchasing** (purchase register, by supplier, pending orders, goods received but not billed, purchase returns), **Receivables and payables** (customer and supplier balances, collections, cheques due), **Cash** (payments by method, expenses by category, shifts and cash variance, the bank and wallet book) and **Tax** (the sales tax summary). One runner serves them: `GET /report-catalogue` lists what the person may run, `GET /report-data/:key` runs one. Filters (each report takes those that fit it): dates (Karachi days, both included, at most ten years), branch, terminal, person, customer, supplier, category, product, location, account, "not sold for N days", and a text search. Rows are **paginated** (50, at most 200); a **totals row** adds up the money and count columns over every row, not just the page; `?format=csv` exports up to 50,000 rows with a totals row, money as plain rupees with two decimals, a byte-order mark so a spreadsheet reads it as UTF-8, and cells that look like a formula made harmless. Dates and filters are validated; a stranger's id simply matches nothing.
- **Profit is a permission** (FR-RPT-04; migration 0024). `reports.profit.view` gates every report that shows cost or profit (the Profit group, stock valuation, the purchasing reports) and the cost and profit **columns inside** other reports and their exports: a person with `reports.sales.view` alone gets the same report without them, in the table and in the CSV, and the profit reports answer 403. `reports.tax.view` gates the tax summary. Owner and Manager hold both. The cashier sees only stock and customer balances (which that role already may).
- **Definitions that matter.** Sales without tax is `taxable_paisa`; cost is `qty x cost` as recorded on the line when it was sold (the weighted average then); **profit and loss** is net sales (without tax, less returns) less the cost of goods sold (less the cost of returned goods put back on the shelf as sellable; damaged and written-off returns keep their cost as a loss) less expenses dated in the range (reversed ones left out). The per-product, per-category, per-customer and per-invoice profit reports are **before returns**; the profit-and-loss report is net of them. The **sales tax summary** gives, for each rate, taxable sales and output tax less returns, taxable purchases and input tax less purchase returns, and the tax to pay (output less input).
- **Dashboard** (FR-RPT-01; `GET /dashboard`, on the home page). Today (Karachi): sales, bills, average bill, credit given, returns, **profit** (the profit-and-loss gross profit for the day), **cash in hand** (what the open drawers should hold, from the same shift summary as the X report, plus the accounts), customers owe, the shop owes suppliers, low-stock items, the best five sellers and a 14-day trend. Each figure is **sent only to someone who may see it** (sales with `reports.sales.view`; profit also needs `reports.profit.view`; cash with `shifts.view_all` or `accounts.view`; balances with the ledger permissions; low stock with `inventory.view`). The figures are the reports' own, which a test holds: the dashboard's total for the day equals the invoice register's and the daily summary's.
- **Day-end closing** (migration 0025, `day_closings`; FR-CSH-07). Per branch and Karachi day: `day_summary` writes down the shifts (float, expected, counted, difference), sales, returns, money by method and expenses by category **inside the closing transaction**, so the record cannot disagree with the ledgers. Refused while a shift opened that day (or earlier) is still open, for a future day, and when the day is closed already. Once closed, **the branch cannot open a new shift on that day** (so no sale lands after the figures were written) **and no expense can be dated into it**. A closing never changes; a mistake is **reopened** with a reason (kept on the record) and the day closed again as a new record. Permissions `shifts.view_all` (look), `cash.close_day` (close and reopen). Pages `/day-closings`, `/day-closings/:id` (printable).
- **Also changed:** printing is no longer blanked for pages other than receipts (the page's menu is hidden when printing a report, and `#root` is hidden only while a receipt is printing); the API client sends a multipart body for file uploads; new businesses are seeded with the expense categories.
- **Not built in v0.7:** a real Excel (.xlsx) file or a PDF file made on the server (the export is CSV, which Excel opens, and PDF is the browser's "save as PDF"); the scheduled daily email to the Owner (FR-RPT-05, could-have); the catalogue's reports for voided and reprinted bills, purchases by product, login history, price changes, manager overrides (the audit log is on its own page), transfers, count variances and expiry (their modules are v0.9), and FBR submission status (v0.8); a per-location or per-user filter on every report (a report takes the filters that fit it); expenses by cheque or wallet account from the register in one step; automatic cheque deposits into an account; a dated "as of" for the balances and stock reports (they are as of now); a hard lock on **other** back-dated postings in a closed day (only shifts and expenses are guarded; manual account entries are not).

Acceptance tests (automated): 1 - `reports-api.test.ts` (the dashboard's total for the seeded day equals the invoice register's and the daily summary's), `reports.spec.ts`; 2 - `reports-api.test.ts` (a sales-only user gets no cost or profit column in any report or export, and 403 from the profit reports; the dashboard sends them no profit), `reports.spec.ts`; 3 - `reports-api.test.ts` (net profit equals sales less returns less cost of goods less expenses, and equals the ledgers read directly, for the seeded month). Accounts and expenses: `accounts-expenses-api.test.ts`, `expenses.spec.ts`; day-end closing: `day-closing-api.test.ts`, `day-closing.spec.ts`.

### v0.8 FBR integration

Scope: FBR settings (Owner only), encrypted token storage, sandbox/production switch, test connection, reference data sync, HS code/UoM/rate/payment mapping, local pre-validation, real-time submission of sales and returns, retry queue, FBR log screen, FBR fields and QR on all print formats, reconciliation report, sandbox scenario runner. Digital Invoicing adapter first, POS fiscal adapter second. SRS: FR-FBR-01–18, FR-PRT-04, FR-RET-08.

Acceptance tests:

1. With the sandbox, a sale is accepted and the slip and A4 both print the FBR number and QR.
2. With FBR unreachable, the sale completes as "FBR pending" and is accepted automatically after FBR returns, with no duplicate.
3. A partial return is accepted as a credit note referencing the original FBR number.
4. A product missing its HS code is blocked before sending, with a clear message.

Acceptance tests (automated): 1 - `fbr-submission-api.test.ts` (accepted at once, the invoice carries FBR's number and QR data), `fbr.spec.ts` (the till shows the number; the 80 mm slip and the A4 duplicate both print it and one QR image); 2 - `fbr-submission-api.test.ts` and `fbr.spec.ts` (FBR down: the sale completes as pending; once FBR is back the retry job accepts it exactly once, and a second run changes nothing); 3 - `fbr-submission-api.test.ts` (a partial return is reported as a debit note against the original FBR number); 4 - `fbr-submission-api.test.ts` (a product without an HS code blocks the sale before anything is posted, naming the product). Settings, token, reference data, mappings and the sandbox scenarios: `fbr-settings-api.test.ts`, `fbr.spec.ts`; the pure rules (mapper, validation, back-off, token encryption): `fbr.test.ts`; the printed block: `receipt.test.ts`.

#### As built in v0.8 (FBR Digital Invoicing)

- **Read this first: the adapter is not verified against FBR.** `server/fbr/adapters/digitalInvoicing.ts` was written from the published PRAL Digital Invoicing specification (field names, the validate and post calls, the sandbox scenario ids) **without a real sandbox token**, so it has never talked to PRAL. Every test runs against the built-in `MockAdapter`. Before the first real client goes live: get a sandbox token from the client's FBR account, run the nine scenarios on `/settings/fbr`, and fix whatever the real answers show (field names, error shapes, the IRN/QR format). The settings page says "Test mode" while the mock is answering (`FBR_ADAPTER=mock`). Leave `FBR_ADAPTER` unset in production.
- **Settings** (migration 0026; `/settings/fbr`, Owner only via `fbr.manage`; `fbr.view` and `fbr.resubmit` go to Manager). Enable, environment (sandbox or production), seller name/NTN/STRN/province/address (falls back to the business profile), how long to keep trying (default 72 h), and the amount above which an invoice needs the buyer's NTN or CNIC. The **token** is encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY` (32 bytes, base64), stored as `v1.<iv>.<tag>.<ciphertext>`, and never sent back to the browser or written to the audit log: the screen only shows "a token is saved" and its last four characters. Test connection; update FBR's lists (provinces, HS codes, units, sale types) by hand or by the `fbr-sync` job; mapping of tax categories (FBR sale type, SRO schedule and item), payment methods and registers; a "what is still missing" panel (seller details, products without an HS code or unit, tax categories without a sale type) that names examples; switching to production needs all nine sandbox scenarios passed or an explicit "go live without them". Changing environment clears the last connection test.
- **Reporting** (`server/fbr/service.ts`). A sale or desk invoice is checked locally **before** it is posted (`fbrPreflight`: seller details, HS code, unit, sale type, buyer number above the threshold) and refused with a message naming what to fix (acceptance 4). The posting transaction then writes one `fbr_submissions` row per document (unique, so a document can never be queued twice) in the same transaction as the invoice; after commit `reportNow` sends it within a short timeout. Outcomes: **accepted** (IRN and QR data stored; accepted submissions are immutable), **rejected** (FBR refused the data: flagged, not retried, fix and resubmit), **transient** (FBR or the network was not there: stays pending), **unauthorised** (token refused: flagged, not retried). A sale never fails because FBR did.
- **Retry** (`GET|POST /api/jobs/fbr-retry`, protected by `CRON_SECRET`, `runDueSubmissions`). Back-off 1, 5, 15, 60 minutes, then hourly; a claim lock (`claimed_until`) stops two runs sending the same document; after the keep-trying window the submission is given up as failed and raised on the dashboard. **The schedule is not in `vercel.json`**: a Hobby plan allows only daily crons. Call the endpoint every minute from an external scheduler (or put it in `vercel.json` on a Pro plan) with `Authorization: Bearer $CRON_SECRET`; `/api/jobs/fbr-sync` refreshes FBR's lists daily the same way.
- **Returns** are reported as a **Debit Note** carrying the original invoice's IRN (acceptance 3). A return waits while its invoice is still pending; one for a sale FBR never saw is skipped, not reported. **Log** (`/fbr/log`, `/fbr/log/:id`): filter by status ("needs attention"), type and date, search by number or IRN, every try with what was sent and answered (kept for the 6-year retention period; the attempt table is append-only), and "Send to FBR again" (idempotent). **Reconciliation** report `fbr-reconciliation` by day (sales, accepted, waiting, refused, given up), and a dashboard card when anything is waiting, refused or given up.
- **Printing** (FR-PRT-04): once accepted, every format (80/58 mm slip, A4, A5) prints "FBR invoice no." and a QR code (content: the IRN) for invoices and credit notes; while pending it says so and tells the cashier to reprint later. The till shows the same on the "Sale complete" screen. The invoice page shows the FBR status.
- **Sandbox scenarios** (FR-FBR-06): nine (SN001, SN002, SN005–SN008, SN026–SN028), each run checks a made-up invoice with FBR's validate call and posts nothing; results are stored per business. The scenario id is attached to real invoices only in the sandbox.
- **Not built in v0.8:** the **POS fiscal adapter** (mode `pos`/`both`; the API refuses them); the Re 1 POS service fee on retail invoices; the manual JSON payload export (FR-FBR-19); buyer verification is on the settings page but not yet inside invoice and customer forms; scenario coverage beyond the nine; the cron schedule in `vercel.json` (above). **Known risk:** if the post call times out after FBR already recorded the invoice, a retry could create a duplicate at FBR; the attempt log shows it, and PRAL guidance is needed on a lookup by our invoice number before this is used live.

### v0.9 Advanced inventory and offline

Scope: stock transfers with in-transit, stock counts with variance posting, damaged location, batch/expiry (optional per product), offline POS (Section 5.5), optional silent printing. SRS: FR-INV-04, 05, 11, 12, NFR-AVL-03.

Acceptance tests:

1. Transfer 20 cartons: source drops on dispatch, destination rises on receipt, in-transit shows between.
2. Unplug the network, make 10 sales, reconnect: all 10 sync in order, none duplicated, FBR submits them.

Acceptance tests (automated): 1 - `stock-transfers-api.test.ts` (20 cartons = 4,000 pieces leave the source on dispatch, show as in transit, arrive on receipt at the cost they left at), `transfers.spec.ts` (through the screens); 2 - `offline-sales-api.test.ts` (ten sales sent in order are numbered in order, once each, and none twice when the whole queue is sent again), `offline.spec.ts` (the browser with its network switched off: ten sales taken, one slip each, then reconnected: all ten posted in order, FBR accepted ten, stock down by ten), `tests/pwa/offline-reload.spec.ts` (the production build with its service worker reloaded with the network off, still sells, and sends the sale on reconnecting). Also: `stock-counts-api.test.ts`, `stock-counts.spec.ts`, `offline.test.ts` (unit: the queue, the local bill, the slip).

#### As built in v0.9 (transfers, stock counts, the till without a connection)

- **Stock transfers** (migration 0027; FR-INV-04, FR-INV-11). Requested (nothing moves) → **dispatched** (stock leaves the source through the ledger at the source's average cost, `stock_transfer_out`) → **received** (stock enters the destination at that same cost, `stock_transfer_in`, so the value that left is the value that arrives). Between dispatch and receipt the goods are **in transit**: on no shelf, shown on the stock list ("4,000 in transit"), in `GET /stock-transfers/in-transit` and on the transfers page. The person receiving can record **less than was sent**; the shortage stays on the line and nothing is posted for goods that never arrived (more than was sent is refused). A requested transfer can be cancelled; a dispatched one cannot, it is received. Refused if the source lacks the stock (unless the business allows negative stock). Numbered `ST-<branch>`; lines and header are immutable except status, cost and received quantity. Permissions `transfers.view`, `transfers.manage` (Owner, Manager). Pages `/transfers`, `/transfers/new`, `/transfers/:id`. **Damaged / quarantine location** (FR-INV-11): the `damaged` location type already existed; moving goods into one with a transfer is how defective or returned stock is quarantined. It stays counted and valued but no register sells from it.
- **Stock counts** (migrations 0028, 0029; FR-INV-05). A count is started for one location, **full** (every active stocked item) or **partial / cycle** (chosen items); at that moment the books' figure and average cost are **frozen** into the count's lines. People count by **scanning** (a carton barcode counts a carton; `3*CODE` counts three) or typing; an item never counted is "not counted", never taken to be zero. **Submitted** for review, the count shows the variance (counted less frozen), its value (cost permission only) and what the stock has done since the freeze; the reviewer **approves** (one stock adjustment for the differences through `post_stock_adjustment`, reason "correction", so the ledger and audit trail are the usual ones), sends it **back for a recount**, or cancels it. One open count per location. The variance is measured against the frozen figure, so a sale made while counting is not taken out twice; on a recount the items that differed are reset and re-frozen from the shelf as it is now. Approval is refused if a variance would take stock below zero. Permissions `inventory.count` (start, count, submit, cancel), `inventory.approve` (approve, send back). Pages `/stock-counts`, `/stock-counts/:id`.
- **The till without a connection** (migration 0030; technical plan 5.5, NFR-AVL-03). When the till cannot reach the server (browser offline, or a request that got no answer) a sale is **kept on the device** (IndexedDB, `pos-outbox:<business>:<user>`, which sign-out does not wipe, because it holds sales not yet sent) with the Idempotency-Key it was first tried with, a **slip reference** (`REGISTER1-OFF-000001`: the terminal's name and a counter that never repeats) and the real time. The slip prints with **"OFFLINE SALE, TO BE SYNCED"** under that reference on every format. The queue is sent **in the order the sales were made**, at once on reconnecting and every 20 seconds while anything waits; a lost connection stops the run and what is left keeps its place; a sale the server **refuses** (for a reason a person must look at) is marked, stays visible with "Try again", and does not hold up the rest. The offline reference and the real time travel in **request headers** (`X-Offline-Ref`, `X-Offline-Sold-At`), not the body, so sending the same sale again with the same key is the very same request and is answered from the stored result: a sale that did reach the server before its reply was lost is never posted twice. The server posts it with the same function as any sale (numbered, costed, stock out, queued for FBR in the same transaction), sets `posted_at` back to when it happened and records the reference (unique per terminal); the invoice stays immutable. **Posted and flagged, not refused**: stock that went below zero (`NEGATIVE_STOCK`), a price or tax that changed meanwhile (`PRICE_CHANGED`: the till's total differed from the server's), a discount above the cashier's limit that no manager could approve (`DISCOUNT_OVER_LIMIT`). Flagged sales are listed for someone with `sales.offline_review` (Owner, Manager) at `/offline-sales` with a note and "Mark as reviewed", and on the dashboard. **Not possible offline**, and the till says why: a sale on account (the customer's balance and limit live on the server), a discount above the cashier's limit, returns, customer payments, cash in/out, closing the shift (refused while offline sales wait; they belong to an open shift), and FBR (reported as each sale is sent). A **service worker** (`public/sw.js`, production build only) keeps the app's pages and hashed files, never touches `/api`, and serves a kept page only when the network fails; the signed-in person and the till's settings are kept as copies in `localStorage` (`pos.offline.*`, removed on sign-out) so a page opened with no connection can start from them. The catalogue and customers were already kept in IndexedDB.
- **Also changed:** the mock FBR now gives every accepted invoice a number of its own (two identical sales on one day are two invoices); `npm run e2e` also runs the production-build test (`npm run e2e:pwa`); with nothing left planned the "Coming soon" menu list is hidden (`src/app/plannedModules.ts` is empty).
- **Not built in v0.9:** **batch and expiry tracking** (FR-INV-12, could-have; the scope line said optional per product) and **optional silent printing** (a browser cannot print without its dialog unless it is started in kiosk-printing mode; nothing was added for it); **per-item "damaged" quantities inside a count** (a count variance is one adjustment; move damaged goods with a transfer); a count of an item whose unit is not the base unit is entered in the base unit on the count screen (scanning handles other units). **Limits of the offline till:** the slip reference stands in for the invoice number until the sale is sent, so the official gap-free invoice number is given **at sync**, not at the till (the slip says so); an offline sale rung up at the old price and the price went **up** meanwhile is posted at the new price and flagged, but if the customer's payment then falls short of the new total (exact card or wallet amount) the server refuses it and it stays in the till's list as refused until someone fixes it; the **service worker is only as good as the last online visit** (open the till once with a connection after each update, or its newest files are not kept), and a page reloaded offline after the sign-in token has expired (about an hour) falls back to the sign-in screen until the connection is back; offline sales are only sent by the same user on the same device (the queue belongs to that user's sign-in); a sale older than 14 days is refused as too old to trust; the till does not check a second device against the same terminal.

### v1.0 Hardening and go-live

Scope: security review (OWASP checklist, RLS tests), performance tests at SRS targets, backups and restore drill, data import tools for go-live (customers, suppliers, opening balances, stock), Sentry alerts, user guide, move to paid Vercel/Supabase plans, production FBR switch-on.

Acceptance tests:

1. Product search returns in under 300 ms with 20,000 SKUs; sale posts in under 1.5 s.
2. Restore last night's backup into staging and reconcile totals.
3. Every SRS "M" requirement is ticked against a test or a walkthrough.

Acceptance tests (automated, except where said): 1 - `unit/performance.test.ts` (search on the device over 20,000 SKUs sold in three units: worst case about 14 ms against 300 ms; building the index about 270 ms) and `integration/performance.test.ts` (20,000 SKUs in the database: product search p95 under 300 ms, sale posting p95 under 1.5 s over twenty sales, and twelve reports plus a CSV export over 100,000 invoice lines each under 10 s); 2 - `npm run drill:local` (backup, restore into a second database, fingerprint both: 83 tables identical row for row; **not** a restore from a hosted backup into a staging project, which needs the hosting: `docs/runbook.md`) and `unit/reconcile.test.ts` (the comparison catches a changed total, a missing row, a changed row and a missing business); 3 - `docs/requirements-trace.md` (all 122 requirements: 95 done and proven, 24 partly done, 1 not built, 2 not testable without hosting or a person).

#### As built in v1.0 (hardening and go-live)

- **Security review** (`docs/security-review.md`, `tests/integration/security.test.ts`). Every one of the 243 API routes answers 401 without a sign-in and 403 to a signed-in person with no permissions, except nine listed with their reasons (the test fails when a new route is neither protected nor on the list); reports, document shares and the dashboard check their own permission inside, tested. Row-level security is on in all tables, the browser roles have no grants on the shop's tables, and signed-in and anonymous reads and writes through the public database interface return nothing. Public routes are exactly the health check, share links and the secret-protected jobs. API answers carry `nosniff`, no framing, no referrer and `no-store`; pages carry HSTS, a strict Content-Security-Policy (no inline script, no eval), a permissions policy and no framing (`vercel.json`). `vite preview` sends the same headers from `vercel.json`, so `tests/pwa` runs a whole sale under the real policy (the one report left is the form checker probing for `eval`, which it survives). **Not done:** a third-party penetration test and `npm audit` (needs the internet).
- **Performance** (migration 0032). Searching by part of a name, SKU or barcode read every row (about 190 ms at 20,000 SKUs); trigram (`pg_trgm`) indexes on product name, SKU and barcode bring the server search under the 300 ms target. The till searches on the device, from its local copy of the catalogue.
- **Go-live import tools.** Customers and suppliers by CSV (`/customers/import`, `/suppliers/import`, with the same check-then-load screen as products): every row is checked with the forms' own rules, a customer already held (same CNIC, or same name and phone) or a supplier name already used is refused, and nothing is saved unless every row is fine. Products, opening stock, customer opening balances and supplier opening payables already existed.
- **Backups and restore** (`docs/runbook.md`, `scripts/reconcile.mjs`, `scripts/restore-drill-local.mjs`). `npm run reconcile` fingerprints a database (per business: sales, payments, returns, stock movements, customer and supplier balances, account balances, expenses; and, for a same-moment comparison, a checksum of every table); `--before <time>` takes the totals as of a time so last night's backup can be compared with the live database as of that time; `--compare` fails on any difference. The hosted-plan parts (retention, point-in-time recovery) are settings to switch on.
- **Observability** (migration 0033, `server/lib/monitoring.ts`). Unhandled errors go to Sentry when `SENTRY_DSN` is set (Sentry's envelope endpoint over plain `fetch`; tested against a local stand-in, **not** against a real Sentry project). More than 5% of the last hour's FBR calls failing (at least ten calls) raises an alert, at most once an hour per business, to the log and to `ALERT_WEBHOOK_URL`; `/api/jobs/fbr-health` and every retry run check it.
- **Two Must gaps found by the traceability check and closed:** a sale cancelled before payment now asks why and is logged with its items (FR-SAL-10: "Cancel sale" replaces "Clear"); the owner can download all the business's data as one JSON file, or any table as CSV, with secrets left out and each download audited (FR-AUD-03; Settings, "Export your data").
- **Documents:** `docs/user-guide.md` (cashier, manager, owner), `docs/runbook.md`, `docs/go-live.md` (checklist and known gaps), `docs/security-review.md`, `docs/requirements-trace.md`.
- **Not done in v1.0, because it needs accounts, money or a person:** moving to the paid Vercel and Supabase plans, the staging project, creating the Sentry project and webhook, the restore from a hosted backup, the third-party security test, the 20-terminal load test, the real FBR sandbox and production switch-on (**the adapter has never talked to PRAL**), and training. `docs/go-live.md` lists them in order. **Gaps left in the product:** see "Known gaps" there (FBR POS mode, further tax, FIFO, exchange, tags and favourites, email/SMS, real Excel/PDF files, editable templates and masking, batch and expiry, denomination count on screen).

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
