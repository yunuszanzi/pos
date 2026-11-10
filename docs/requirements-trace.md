# Requirements traceability: every "Must" in the SRS against a test or a walkthrough

Written for v1.0 (acceptance test 3). Each Must requirement of `docs/srs.md` is listed with where it is built and what proves it.
**Done** means built as written and covered by an automated test (named) or, where no test can reach it, a walkthrough step (see
`docs/user-guide.md` and `docs/go-live.md`). **Partly** means the main intent is met and something specific is missing, said in the last column.
**Not built** means it is not in the product yet. Nothing is ticked that was not checked against the code.

Test names are files under `tests/unit`, `tests/integration` (API and database, against a real Postgres) and `tests/e2e` (a real browser);
`pwa/` is the production-build browser test.

**Result:** of 122 requirements, 95 are done, 24 are partly done, 1 is not built (exchange), and 2 cannot be tested without hosting or a person.
The gaps that matter before go-live are listed in `docs/go-live.md` under "Known gaps".

## Users and organisation

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-USR-01 | Sign in, hashed passwords, configurable inactivity expiry | Done | Supabase Auth hashes passwords; expiry is a setting. `sign-in.spec`, `settings.test`. Sign-in is by email (no separate username). |
| FR-USR-02 | Switch user at a terminal with a PIN | Done | `pin.test`, `user-management.test`, `foundation.spec` |
| FR-USR-03 | Role permission matrix, custom roles | Done | `user-management.test`, `api-security.test`, `security.test` (every route needs its permission) |
| FR-USR-04 | Manager override with PIN, recorded | Done | `sales-api.test` (discount above limit), `credit-api.test` (credit limit), `pin.test` |
| FR-USR-06 | Password reset by email; Owner resets; deactivate without deleting | Done | `user-management.test`; email reset is Supabase's `resetPasswordForEmail` (walkthrough: user guide, "Forgot password") |
| FR-ORG-01 | Business profile | Done | `foundation-acceptance.test`, `foundation.spec` |
| FR-ORG-02 | Branches and warehouses as stock locations | Done | `foundation-acceptance.test`, `stock-transfers-api.test` |
| FR-ORG-03 | Terminals with number series, print defaults, FBR POS ID | Done | `foundation-acceptance.test`, `fbr-settings-api.test` |
| FR-ORG-04 | Configurable gap-free numbering | Done | `sales-database.test`, `foundation-acceptance.test` |

## Products and stock

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-PRD-01 | Products with SKU, barcodes, category, brand, prices, tax, HS code | Done | `catalogue-api.test`, `catalogue.spec` |
| FR-PRD-02 | Variants, each its own SKU, stock and price | Done | `catalogue-api.test` |
| FR-PRD-03 | Several units with conversion factors; stock in the base unit | Done | `units.test`, `stock.spec` (10 cartons show as 2,000 pieces) |
| FR-PRD-04 | Several barcodes; generate internal EAN-13/Code128 | Done | `barcode.test`, `barcodeImage.test`, `labels.spec` |
| FR-PRD-05 | Price lists, customer prices, quantity breaks | Done | `priceLists.test`, `price-lists.spec` |
| FR-PRD-07 | Category tree, brands, **tags** | Partly | Categories and brands: `catalogue-api.test`. **Tags are not built.** |
| FR-PRD-08 | Reorder level and quantity | Partly | Reorder level and quantity per product: `reorder-api.test`. Not per location (one level per SKU). |
| FR-PRD-09 | Bulk import/export of products and prices, with preview | Partly | `productImport.test`, `catalogue-api.test`. **CSV only**; an Excel file must be saved as CSV first. |
| FR-INV-01 | On hand, reserved, available per location | Done | `inventory-api.test`, `sales-orders-api.test` |
| FR-INV-02 | Stock ledger with running balance and filters | Done | `stock-ledger.test`, `stock.spec` |
| FR-INV-03 | Adjustments with reason; approval above a threshold | Done | `inventory-api.test`, `stock.spec` |
| FR-INV-04 | Transfers with in-transit | Done | `stock-transfers-api.test`, `transfers.spec` |
| FR-INV-05 | Physical counts, freeze, scan, variance, post on approval | Done | `stock-counts-api.test`, `stock-counts.spec` |
| FR-INV-06 | Weighted average cost; **FIFO as a setting** | Partly | Weighted average: `stock-ledger.test`. **FIFO is not built.** |
| FR-INV-07 | Negative stock allowed or blocked, **per business and per product** | Partly | Per business: `sales-api.test`, `settings.test`. **Per product is not built.** |
| FR-INV-08 | Low-stock alerts; reorder list into purchase orders | Partly | Dashboard card and reorder list to purchase orders: `reorder-api.test`, `reorder.spec`. **No email or WhatsApp alert.** |
| FR-INV-09 | Opening stock import | Done | `inventory-api.test`, `stock.spec` |
| FR-INV-10 | Valuation at cost and sale price, as of any date | Done | `inventory-api.test` (valuation as of a day) |

## Selling

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-SAL-01 | Add by scan, search, category grid, **favourites** | Partly | Scan and search: `posCatalogue.test`, `pos.spec`. The tile grid shows the first 48 items; **no favourites or quick keys, no product images on tiles.** |
| FR-SAL-02 | Quantity, unit, price, line discount, stock per line | Done | `posCart.test`, `pos.spec` |
| FR-SAL-03 | Customer with tier and balance | Done | `customers.spec`, `credit.spec`, `posCustomers.test` |
| FR-SAL-04 | Line and invoice discounts, role limits, reason above limit | Done | `pricing.test`, `sales-api.test`. Above the limit a manager approves with a PIN; a typed reason is not asked for. |
| FR-SAL-05 | Tax per line, inclusive/exclusive, **further tax for unregistered buyers** | Partly | `pricing.test`, `pos.spec`. **Further tax is not calculated** (the FBR payload sends 0). |
| FR-SAL-06 | Hold and recall sales | Done | `pos-api.test`, `pos.spec` |
| FR-SAL-07 | Cash, card, transfer, wallet, cheque, khata, store credit; split | Done | `payments.test`, `pos.spec`, `cheques.spec`, `credit.spec`. Store credit is a credit balance on the customer's khata, not a printed voucher. |
| FR-SAL-08 | Credit blocked or needs a manager above the limit or overdue | Done | `credit-api.test`, `credit.spec` |
| FR-SAL-09 | Post invoice, stock, ledger, FBR, then print/share | Done | `sales-api.test`, `fbr-submission-api.test` |
| FR-SAL-10 | Void a line; void a whole unpaid sale, logged with reason | Done | Removing a line needs no reason. `sale-void-api.test`, `void-sale.spec` |
| FR-SAL-11 | Keyboard shortcuts | Done | `pos.spec` (F-keys), `posCart.test` |

## Returns

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-RET-01 | Find the sale by **scanning the bill**, number, customer, date | Partly | By number, customer and date: `returns-api.test`, `returns.spec`. **The bill carries no barcode of its own to scan** (only the FBR QR). |
| FR-RET-02 | Full or partial; cannot exceed what was sold | Done | `returns-api.test`, `returns.test` |
| FR-RET-03 | Reason per line; restock, damaged, write-off | Done | `returns-api.test` |
| FR-RET-04 | Refund by method, cash, credit note or khata | Done | `returns-api.test`, `returns.spec` |
| FR-RET-05 | **Exchange** in one flow | Not built | A return followed by a new sale does the same work in two steps. |
| FR-RET-08 | Credit note printed; reported to FBR as a debit note | Done | `receipt.test`, `fbr-submission-api.test` (acceptance 3 of v0.8) |
| FR-RET-09 | Discounts and tax reversed proportionally | Done | `returns.test`, `returns-api.test` |

## Printing and sharing

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-PRT-01 | 80 mm and 58 mm slips via the print dialog | Done | `receipt.test`, `pos.spec` |
| FR-PRT-02 | A4 and A5 for invoices, quotations, orders, challans, credit notes, statements | Done | `receipt.test`, `invoices.spec`, `delivery-challans.spec`, `statements.spec` |
| FR-PRT-03 | Receipt content | Done | `receipt.test` |
| FR-PRT-04 | FBR fields and QR on the bill | Done | `receipt.test`, `fbr.spec` |
| FR-PRT-05 | Auto-print; reprints marked DUPLICATE and logged | Done | `pos.spec` |
| FR-PRT-07 | Download as PDF; share by WhatsApp, **email, SMS** | Partly | WhatsApp links and a public document page: `document-shares-api.test`. PDF is the browser's "save as PDF". **No email or SMS sending.** |

## Quotations, orders, invoices

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-QUO-01 | Quotation with items, prices, validity, terms | Done | `quotations-api.test`, `quotations.spec` |
| FR-QUO-02 | No effect on stock or ledgers | Done | `quotations-api.test` |
| FR-QUO-03 | Statuses | Done | `quotations-api.test` |
| FR-QUO-04 | Convert fully or partly, keeping prices | Done | `quotations-api.test`, `sales-orders-api.test` |
| FR-QUO-06 | Print, PDF, WhatsApp, **email** | Partly | As FR-PRT-07: no email sending. |
| FR-SO-03 | Back-office invoice with terms and due date | Done | `sales-invoices-api.test`, `invoices.spec` |
| FR-SO-04 | Tax invoice with buyer NTN/STRN | Done | `sales-invoices-api.test`, `receipt.test` |

## Customers and suppliers

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-CUS-01 | Customer record | Done | `customers-api.test`, `customers.spec`, `party-import-api.test` |
| FR-CUS-02 | Khata ledger with running balance | Done | `credit-api.test`, `khata.test` |
| FR-CUS-03 | Receive payment against invoices or on account; receipt | Done | `credit-api.test`, `credit.spec` |
| FR-CUS-04 | Ageing and overdue list | Done | `statements-api.test`, `khata.test` |
| FR-CUS-05 | Statement for a range, PDF/WhatsApp | Done | `statements-api.test`, `statements.spec` |
| FR-CUS-06 | Opening balances import | Done | `customers-api.test`, `credit.spec` |
| FR-PUR-01 | Supplier record, opening balance | Done | `suppliers-api.test`, `suppliers.spec`, `party-import-api.test` |
| FR-PUR-02 | Purchase orders with statuses | Done | `purchasing-api.test`, `purchasing.spec` |
| FR-PUR-03 | Goods receipt, partial, average cost | Done | `purchasing-api.test`, `purchasing.test` |
| FR-PUR-04 | Supplier bill with tax and landed costs | Done | `purchase-bills-api.test`, `purchase-bills.spec`, `purchaseBills.test` |
| FR-PUR-05 | Purchase return / debit note | Done | `payables-api.test` |
| FR-PUR-06 | Supplier ledger, payments, ageing | Done | `payables-api.test`, `supplier-payments.spec` |

## Cash, tax, reports

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-CSH-01 | Open shift with float; one per terminal | Done | `shifts-api.test`, `pos.spec` |
| FR-CSH-02 | Cash in/out with reason | Done | `shifts-api.test` |
| FR-CSH-03 | Close shift: blind count **by denomination**, variance, Z-report | Partly | Blind count, variance and Z report: `shifts-api.test`, `pos.spec`. The API stores a breakdown by note and coin, but **the screen asks for one counted total.** |
| FR-CSH-05 | Expenses with category, source, attachment | Done | `accounts-expenses-api.test`, `expenses.spec` |
| FR-TAX-01 | Tax categories as settings | Done | `catalogue-api.test` |
| FR-TAX-03 | Inclusive/exclusive, rounding rules | Done | `pricing.test` |
| FR-TAX-05 | Sales tax summary | Done | `reports-api.test` |
| FR-RPT-01 | Dashboard | Done | `reports-api.test`, `reports.spec` |
| FR-RPT-02 | Filters on every report; export to **Excel/CSV and PDF** | Partly | Filters and CSV (opens in Excel): `reports-api.test`, `reports.spec`. **No .xlsx file; PDF is the browser's.** |
| FR-RPT-03 | Full report list (SRS 7.2) | Partly | 36 reports: `reports-api.test`. Voided/reprinted bills, purchases by product, login history, price changes and manager overrides have no report of their own (the audit history shows them). |
| FR-RPT-04 | Profit hidden without permission | Done | `reports-api.test` |

## Settings and audit

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-SET-01 | Currency format, rounding, date format, time zone, tax mode | Done | `settings.test` |
| FR-SET-02 | POS behaviour settings, discount limits per role | Partly | Negative stock, auto-print, return window, discount limits per role: `settings.test`, `sales-api.test`. **No "default customer" or "require customer for credit" setting** (credit already requires a named customer). |
| FR-SET-03 | Payment methods, FBR payment mapping | Done | `fbr-settings-api.test` |
| FR-SET-04 | Print templates | Partly | Six fixed layouts the user selects (`receipt.test`). **Templates cannot be edited.** |
| FR-SET-05 | FBR settings | Done | `fbr-settings-api.test`, `fbr.spec` |
| FR-AUD-01 | Audit log of changes, voids, reprints, overrides, logins | Done | `foundation-acceptance.test`, `sale-void-api.test`, `pos.spec` |
| FR-AUD-02 | Soft delete; posted documents never deleted | Done | `sales-database.test`, `database-security.test` |
| FR-AUD-03 | Owner exports all data | Done | `export-api.test`, `export.spec` |
| FR-AUD-04 | Daily backups, 30-day retention, **tested restore** | Partly | Restore tested: `npm run drill:local` and `tests/unit/reconcile.test.ts`. **Daily backups and 30-day retention are the hosting plan's** (Supabase Pro), switched on at go-live (`docs/go-live.md`). |

## FBR

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| FR-FBR-01 | Settings screen, Owner only, **mode POS / DI / both** | Partly | Digital Invoicing only: `fbr-settings-api.test`. **The POS fiscal mode is not built.** |
| FR-FBR-02 | Token encrypted, masked, never to the browser | Done | `fbr-settings-api.test`, `security.test` |
| FR-FBR-03 | Test connection | Done | `fbr-settings-api.test`, `fbr.spec` |
| FR-FBR-04 | Sync reference data on demand and on a schedule | Done | `fbr-settings-api.test`; the schedule is an external call to `/api/jobs/fbr-sync` (`docs/go-live.md`) |
| FR-FBR-05 | Map products, tax categories, payment methods | Done | `fbr-settings-api.test` |
| FR-FBR-10 | Block a sale that lacks FBR's fields, with a clear message | Done | `fbr-submission-api.test` |
| FR-FBR-11 | Send (validate, then post); store IRN and response | Done | `fbr-submission-api.test`. **Against the built-in mock only; never run against PRAL's real service** (`docs/go-live.md`). |
| FR-FBR-12 | Returns as debit notes against the original | Done | `fbr-submission-api.test` |
| FR-FBR-13 | Unreachable: complete as pending, retry with back-off, reprint later | Done | `fbr-submission-api.test`, `fbr.spec`, `offline.spec` |
| FR-FBR-14 | Never report the same invoice twice | Done | `fbr-submission-api.test`, `offline-sales-api.test`. A post that times out after FBR recorded it can still be repeated; see `docs/go-live.md`. |
| FR-FBR-15 | FBR log with requests, responses, retry, filters | Done | `fbr-submission-api.test`, `fbr.spec` |
| FR-FBR-16 | Rejected invoices flagged on the dashboard | Done | `fbr-submission-api.test` |

## Non-functional "Must" requirements

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| NFR-PRF-01 | Search under 300 ms at 20,000 SKUs | Done | `unit/performance.test` (device search about 14 ms), `integration/performance.test` (server search, with trigram indexes) |
| NFR-PRF-02 | Sale under 1.5 s; FBR must not block more than 5 s | Done | `integration/performance.test` (sale p95); the sale waits at most 4 s for FBR and then completes as pending (`fbr-submission-api.test`) |
| NFR-PRF-03 | Reports to 100,000 lines under 10 s | Done | `integration/performance.test` (twelve reports and a CSV export over 100,000 lines). Larger exports are not yet background jobs. |
| NFR-PRF-04 | 20 terminals and 10 back-office users | Partly | Concurrency of postings is tested (`sales-api.test`, `database-security.test`); **no 20-terminal load test has been run.** |
| NFR-AVL-01 | 99.5% uptime | Not testable here | Depends on the hosting plan; see `docs/go-live.md` |
| NFR-AVL-02 | Daily backups and point-in-time recovery, RPO 15 min, RTO 4 h | Partly | Restore procedure and rehearsal exist (`docs/runbook.md`); **PITR needs the paid Supabase plan.** |
| NFR-AVL-03 | Offline up to 8 hours with queued sales | Done | `offline-sales-api.test`, `offline.spec`, `pwa/offline-reload.spec`. Limits are listed in `docs/technical-plan.md` (v0.9). |
| NFR-SEC-01 | HTTPS everywhere; short-lived JWT | Done | HSTS and security headers in `vercel.json`, checked in `pwa/offline-reload.spec`; JWTs are Supabase's |
| NFR-SEC-02 | Server-side authorisation on every call; tenant isolation | Done | `security.test` (all routes need sign-in and permission; the database refuses direct access) |
| NFR-SEC-03 | Secrets encrypted or in environment; OWASP; rate-limited login | Done | `fbr-settings-api.test`, `security.test`, `pin.test` (PIN attempts limited); login rate limit is Supabase Auth's. OWASP review: `docs/security-review.md` |
| NFR-SEC-04 | CNIC and phone visible only to permitted roles; masked on printouts | Partly | Customer screens need `customers.view`; **printouts are not masked.** |
| NFR-INT-01 | Postings in one transaction | Done | `sales-database.test` |
| NFR-INT-02 | Two sales of the last unit cannot both succeed | Done | `sales-database.test` |
| NFR-USA-01 | Full POS flow by keyboard and scanner; touch targets 44 px | Partly | Keyboard flow: `pos.spec`. **Touch-target size has not been measured.** |
| NFR-USA-02 | New cashier can sell after 15 minutes | Not testable here | Needs a person; the cashier chapter of `docs/user-guide.md` is written to that aim |
| NFR-USA-03 | Plain-language errors, FBR codes translated | Done | Throughout; `fbr-submission-api.test` |
| NFR-MNT-01 | Automated tests for pricing, tax, stock, posting (80% coverage) | Partly | Heavy tests on all of them; **coverage is not measured** |
| NFR-MNT-02 | Versioned migrations; previews; staging with FBR sandbox | Partly | `migrations.test`, `migration-upgrade.test`; **previews and staging need the hosting set up** |
| NFR-CMP-01 | Records 6 years; FBR rules configurable | Done | FBR attempt log is append-only (`fbr-submission-api.test`); rates are settings |
| NFR-OBS-01 | Error tracking; alert above 5% FBR failure in an hour | Done | `monitoring.test`. **Sentry delivery is built to Sentry's documented format and not yet seen by a real Sentry project.** |
