# POS System — Software Requirements Specification

Nov 2, 2026 · @Umair Ali

## 1. Introduction

This SRS defines a generic, web-based Point of Sale (POS) and back-office system for a Pakistani trading business: counter sales, wholesale invoicing, quotations, purchasing, returns, inventory, credit (khata) accounts, reporting and FBR fiscal integration. It is written generic first; the SGA Balloons customisation (wholesale balloon distribution across Karachi) will be layered on later.

### 1.1 Purpose

The document is the single agreed reference for what the system must do. It is the input for the technical design document, which will split delivery into versions that are each fully functional and testable.

### 1.2 Scope

In scope:

- Point of sale (retail counter and wholesale order entry) with receipt and A4 invoice printing
- Sales returns, exchanges, credit notes and refunds
- Quotations / estimates and their conversion to sales orders or invoices
- Product catalogue, multi-unit packaging (piece, pack, carton), barcodes, price lists
- Inventory: stock levels, multiple locations, adjustments, transfers, stock counts, batches and expiry where needed
- Purchasing: purchase orders, goods receipt, purchase invoices, purchase returns
- Customers and suppliers, credit limits, ledgers, receivables and payables
- Payments: cash, card, bank transfer, mobile wallets, cheques, split and partial payments
- Expenses, cash register (shift) management, day-end closing
- Taxes, discounts and promotions
- FBR integration: POS fiscalisation and Digital Invoicing (DI) through PRAL
- Reports, dashboards, user roles, audit trail, settings, backups

Out of scope for this version: full double-entry accounting (general ledger, balance sheet), payroll, e-commerce storefront, manufacturing / bill of materials. Section 7 lists these as future enhancements.

### 1.3 Definitions

| Term | Meaning |
| --- | --- |
| POS | Point of Sale — the counter screen where sales are rung up |
| SKU | Stock Keeping Unit — one sellable product variant |
| UoM | Unit of Measure (piece, pack, dozen, carton) |
| FBR | Federal Board of Revenue, Pakistan |
| PRAL | Pakistan Revenue Automation (Pvt) Ltd, operator of FBR's integration APIs |
| DI | FBR Digital Invoicing — real-time e-invoicing for sales-tax-registered persons |
| IRN / FBR invoice no. | Unique invoice number FBR returns for each fiscalised invoice |
| NTN / STRN / CNIC | National Tax Number / Sales Tax Registration Number / national ID card number |
| Khata | Customer credit account (sales on credit, settled later) |
| GRN | Goods Received Note |
| Shift / Register | A cashier session on one terminal, opened with a float and closed with a cash count |
| Tenant | One business using the system (for future multi-business hosting) |

### 1.4 References

- [PRAL Technical Specification for DI API, v1.12](https://download1.fbr.gov.pk/Docs/20257301172130815TechnicalDocumentationforDIAPIV1.12.pdf)
- SRO 1006(I)/2021 — printed content of FBR-integrated POS invoices ([summary](https://github.com/Tier3-Pk/FBR-POS-INTEGRATION-SERVICES))
- S.R.O. 1852(I)/2025, S.R.O. 1666(I)/2026 and Sales Tax General Order 01 of 2026 ([overview](https://lookuptax.com/docs/einvoicing/fbr-digital-invoicing-pakistan))

### 1.5 Requirement conventions

Each requirement has an ID (e.g. FR-SAL-04). Priority: **M** = must have for first release, **S** = should have, **C** = could have later. The technical document will map each ID to a version.

## 2. Overall description

The system is a browser-based single-page application (React) served from Vercel, backed by server-side API functions and a managed relational database. All FBR calls and secrets stay on the server; terminals only talk to the system's own API.

### 2.1 Product perspective

The diagram below shows the main parts and how they connect. Hosting is Vercel and the database is Supabase (PostgreSQL); the technical document will fix the remaining choices.

&#91;embedded content: system architecture · browser, Vercel, external services\]

Terminals load the React app from Vercel and call only the system's API functions; those functions own the database, FBR submissions and outgoing messages, so credentials never reach a terminal.

### 2.2 User roles

| Role | Typical person | Can do |
| --- | --- | --- |
| Owner / Super Admin | Business owner | Everything, including settings, FBR credentials, user management, deleting records, viewing profit |
| Manager | Branch or store manager | Approve discounts beyond limit, returns, price overrides, stock adjustments, purchasing, all reports except owner-only |
| Cashier | Counter staff | Open/close shift, make sales, take payments, print receipts, process returns within policy |
| Salesperson / Order booker | Field or counter sales staff | Create quotations and sales orders, view stock and their own customers, no cash handling |
| Inventory Keeper | Warehouse staff | Receive goods, transfers, stock counts, adjustments (subject to approval) |
| Accountant | Bookkeeper | Customer/supplier ledgers, payments, expenses, financial and tax reports, FBR submission log |
| Read-only Auditor | External accountant | View reports and records, no changes |

Roles are templates; the Owner can create custom roles from a permission matrix (FR-USR-03).

### 2.3 Operating environment

- Frontend: React (SPA), responsive from 360 px phones to 1920 px counter screens; touch and keyboard/barcode-scanner friendly
- Hosting: Vercel (static frontend + serverless/edge API functions); HTTPS only; database on Supabase (PostgreSQL) with row-level security, so the system is usable from any phone or computer through the browser
- Browsers: latest two versions of Chrome and Edge (primary, needed for printing and USB/serial hardware); Safari and Firefox for back-office screens
- Hardware: USB/Bluetooth barcode scanners (keyboard-wedge), 80 mm and 58 mm thermal receipt printers, A4/A5 laser printers, optional cash drawer (kicked by the receipt printer), optional label printer for barcodes
- Network: internet required for normal operation; an offline sale mode covers short outages (NFR-AVL-03)
- Language: English UI first, with Urdu labels on printed bills as an option (FR-SET-06)
- Currency: PKR, two decimal places, amounts rounded per settings

### 2.4 Design and implementation constraints

- Must deploy on Vercel; long-running background work must use scheduled functions or a queue, not always-on servers
- FBR tokens and keys are stored encrypted server-side and are never sent to the browser
- FBR integration must follow PRAL's published specifications and switch between sandbox and production per business
- Printing must work from the browser without installing a desktop app (browser print dialog with print-ready layouts); silent/direct printing is an optional add-on
- All money values are stored as integers in paisa (or fixed-point decimals), never floating point
- Every financial document is immutable once posted; corrections are made by return, credit/debit note or reversal, never by editing

### 2.5 Assumptions and dependencies

- The business has (or will obtain) NTN/STRN and FBR/PRAL integration credentials before switching FBR on; the system works fully with FBR off
- A managed database with point-in-time recovery is available to the Vercel deployment: Supabase (managed PostgreSQL), free tier during development and the paid tier (with point-in-time recovery) before go-live
- Tax rates and FBR reference codes (HS codes, UoMs, sale types) can change; they are configuration and synced data, not code
- SGA Balloons-specific rules (product attributes such as size/colour/print, price tiers, delivery routes) will be added as configuration or a later version

## 3. Functional requirements

Requirements are grouped by module. Each module can be built and tested on its own once its dependencies (users, products) exist.

### 3.1 Authentication, users and permissions (USR)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-USR-01 | Users sign in with email/username and password; passwords hashed (bcrypt/argon2); session expires after configurable inactivity (default 30 min back office, 12 h POS) | M |
| FR-USR-02 | Cashiers can switch user at a terminal with a 4–6 digit PIN without a full logout | M |
| FR-USR-03 | Role-based access control: permission matrix per module and action (view, create, edit, approve, delete, export); custom roles | M |
| FR-USR-04 | Manager override: a restricted action (discount above limit, price override, return without receipt, void) prompts for a manager PIN and records who approved | M |
| FR-USR-05 | Users can be restricted to specific branches/locations and terminals | S |
| FR-USR-06 | Password reset by email; Owner can reset any user; deactivate user without deleting history | M |
| FR-USR-07 | Optional two-factor authentication (TOTP) for Owner and Accountant | C |
| FR-USR-08 | Login history: time, IP, device, success/failure | S |

### 3.2 Business setup, branches and terminals (ORG)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-ORG-01 | Business profile: legal name, trade name, logo, address, phone, NTN, STRN, province, receipt footer text | M |
| FR-ORG-02 | Multiple branches/stores and warehouses, each a stock location | M |
| FR-ORG-03 | Terminals (registers) per branch, each with its own document number series, default printer settings and optional FBR POS ID | M |
| FR-ORG-04 | Document numbering: configurable prefix + sequence per document type and branch (e.g. INV-KHI-000123), gap-free for posted invoices | M |
| FR-ORG-05 | Fiscal year and financial period locking (no posting into a closed period) | S |

### 3.3 Product catalogue (PRD)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-PRD-01 | Create, edit, archive products with: name, SKU, barcode(s), category, brand, description, image, cost price, sale price, tax category, HS code, status | M |
| FR-PRD-02 | Product variants from attributes (e.g. size, colour, design) — each variant is its own SKU with its own stock and price | M |
| FR-PRD-03 | Multiple units of measure per product with conversion factors (e.g. 1 carton = 20 packs = 2,000 pieces); sell and buy in any defined unit; stock kept in the base unit | M |
| FR-PRD-04 | Multiple barcodes per product/unit (piece barcode vs carton barcode); generate internal barcodes (EAN-13/Code128) for products without one | M |
| FR-PRD-05 | Price lists / tiers: retail, wholesale, dealer, and customer-specific prices; quantity-break pricing (e.g. 10+ cartons = lower price) | M |
| FR-PRD-06 | Product types: stocked item, non-stock item, service, bundle/kit (sold as one, deducts components) | S |
| FR-PRD-07 | Categories and sub-categories (tree), brands, tags | M |
| FR-PRD-08 | Minimum (reorder) level and reorder quantity per product per location | M |
| FR-PRD-09 | Bulk import and export of products and prices via CSV/Excel with validation preview | M |
| FR-PRD-10 | Print barcode labels (sheet or label printer) with name, price, barcode | S |
| FR-PRD-11 | Track batch/lot numbers and expiry dates per product (switchable per product) | C |
| FR-PRD-12 | Track serial numbers per unit (switchable per product) | C |
| FR-PRD-13 | Price change history with user and date | S |

### 3.4 Inventory and stock management (INV)

Stock moves only through documents (sale, return, purchase receipt, transfer, adjustment, count). Every move writes an immutable stock ledger entry with quantity, cost, location, document reference, user and time.

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-INV-01 | Real-time on-hand, reserved (on open sales orders), and available quantity per product per location | M |
| FR-INV-02 | Stock ledger (movement history) per product with running balance, filterable by date, location, document type | M |
| FR-INV-03 | Stock adjustments with mandatory reason (damage, theft, expiry, found, correction); above a value threshold needs manager approval | M |
| FR-INV-04 | Stock transfers between locations: request → dispatch (out of source) → receive (into destination), with in-transit quantity | M |
| FR-INV-05 | Physical stock count: freeze snapshot, count by scanning or entry (full or partial/cycle count), variance report, post adjustments on approval | M |
| FR-INV-06 | Costing method: weighted average cost (default); FIFO as a setting | M |
| FR-INV-07 | Setting: allow or block selling below zero stock, per business and per product | M |
| FR-INV-08 | Low-stock alerts on dashboard and by email/WhatsApp link; reorder suggestion list that can be turned into purchase orders | M |
| FR-INV-09 | Opening stock import for go-live | M |
| FR-INV-10 | Stock valuation report at cost and at sale price, as of any date | M |
| FR-INV-11 | Damaged / quarantine location for returned or defective goods | S |
| FR-INV-12 | Expiry alerts for batch-tracked products | C |

### 3.5 POS sales screen (SAL)

The POS screen is the fastest path from scan to printed bill. Target: a 5-line cash sale completed in under 30 seconds by a trained cashier.

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-SAL-01 | Add items by barcode scan, search (name, SKU, barcode, partial match), category grid with images, or favourites/quick keys | M |
| FR-SAL-02 | Change quantity, unit (piece/pack/carton), price (if permitted) and line discount per line; remove line; show available stock per line | M |
| FR-SAL-03 | Select customer (walk-in by default, search by name/phone, quick-add new); customer's price tier and credit balance apply automatically | M |
| FR-SAL-04 | Discounts: line and invoice level, percentage or fixed; limits per role; reason required above limit | M |
| FR-SAL-05 | Taxes calculated per line from the product's tax category; tax-inclusive or tax-exclusive pricing per setting; further tax for unregistered buyers where applicable | M |
| FR-SAL-06 | Hold / park a sale and recall it later; multiple held sales per terminal | M |
| FR-SAL-07 | Payment: cash (with change calculation), card, bank transfer, mobile wallet (JazzCash/Easypaisa), cheque, customer credit (khata), store credit/voucher; split across several methods; partial payment leaves balance on account | M |
| FR-SAL-08 | Credit sale blocked or needs manager approval when it exceeds the customer's credit limit or overdue days | M |
| FR-SAL-09 | On completion: post invoice, deduct stock, update customer ledger, fiscalise with FBR if enabled, then print/share | M |
| FR-SAL-10 | Void a line before payment; void a whole unpaid sale (logged with reason) | M |
| FR-SAL-11 | Keyboard shortcuts for all common actions (F-keys for pay, hold, customer, discount) | M |
| FR-SAL-12 | Order notes, delivery address and salesperson on the sale (for commission reports) | S |
| FR-SAL-13 | Loyalty points: earn per amount, redeem as discount | C |
| FR-SAL-14 | Promotions engine: buy X get Y, bundle price, time-bound discount, category discount | C |
| FR-SAL-15 | Customer-facing second display (total and items) | C |
| FR-SAL-16 | Rounding of cash totals to nearest 1/5/10 rupees per setting, with rounding shown on the bill | S |

### 3.6 Returns, exchanges and refunds (RET)

A return is always a new document linked to the original invoice; the original is never edited.

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-RET-01 | Find the original sale by scanning the bill's barcode/QR, invoice number, customer, or date | M |
| FR-RET-02 | Return full or partial quantities per line; system blocks returning more than was sold minus earlier returns | M |
| FR-RET-03 | Return reason per line (defective, wrong item, customer changed mind, expired) and restock choice: back to sellable stock, to damaged location, or write-off | M |
| FR-RET-04 | Refund by original payment method, cash, store credit / credit note, or adjustment to customer khata | M |
| FR-RET-05 | Exchange: return and new sale in one flow, only the difference is paid or refunded | M |
| FR-RET-06 | Return without original receipt only with manager approval, at current or lowest recent price | S |
| FR-RET-07 | Return window (e.g. 7/14/30 days) per setting; outside window needs manager approval | S |
| FR-RET-08 | Printed return receipt / credit note; if FBR is enabled the return is reported to FBR as the required credit/debit note referencing the original FBR invoice number | M |
| FR-RET-09 | Discounts and tax on the original sale are reversed proportionally | M |

### 3.7 Printing and sharing (PRT)

Every printable document (sale bill, return/credit note, quotation, invoice, payment receipt, statement) can be printed either as a **POS slip** (80 mm / 58 mm thermal) or as a **full page** (A4 / A5). The user picks the format at print time; defaults are set per terminal and per document type.

- **FR-PRT-00 (M)** — Print format selector on every print/reprint action: POS slip 80 mm, POS slip 58 mm, A4, A5. The last choice is remembered per terminal.
- **FR-PRT-00a (M)** — Default format per document type and per terminal (e.g. counter terminal: POS slip for bills; back office: A4 for invoices and quotations).
- **FR-PRT-00b (S)** — "Print both" option (POS slip for the customer + A4 copy for file) and number of copies per format.
- Both formats carry the same data, including FBR fields when FBR is on; only the layout differs.

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-PRT-01 | Thermal receipt layouts for 80 mm and 58 mm printers via the browser print dialog with a print-ready stylesheet | M |
| FR-PRT-02 | A4 and A5 invoice layouts for wholesale/tax invoices, quotations, purchase orders, delivery challans, credit notes, statements | M |
| FR-PRT-03 | Receipt content: logo, business name/address/phone, NTN/STRN, invoice no., date/time, cashier, customer, items (name, qty, unit, price, discount, tax, total), subtotal, discount, tax, total, paid, change, balance, payment methods, footer, invoice barcode/QR for returns | M |
| FR-PRT-04 | When FBR is enabled, the printed bill carries all FBR-mandated fields (Section 4.4) | M |
| FR-PRT-05 | Auto-print on sale completion (setting), reprint any document (marked "DUPLICATE" and logged) | M |
| FR-PRT-06 | Template settings: show/hide fields, header/footer text, terms and conditions, Urdu text, font size | S |
| FR-PRT-07 | Download any document as PDF; share via WhatsApp (link or PDF), email, or SMS link | M |
| FR-PRT-08 | Open the cash drawer on cash payment through the receipt printer | S |
| FR-PRT-09 | Optional direct/silent printing through a small local print helper or WebUSB/Web Serial ESC/POS on supported browsers | C |
| FR-PRT-10 | Kitchen/packing slip (items without prices) for warehouse picking | S |

### 3.8 Quotations / estimates (QUO)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-QUO-01 | Create quotation with customer (or prospect), items, units, prices, discounts, taxes, validity date, terms | M |
| FR-QUO-02 | Quotations do not affect stock or ledgers | M |
| FR-QUO-03 | Statuses: draft, sent, accepted, rejected, expired, converted | M |
| FR-QUO-04 | Convert a quotation to a sales order or invoice in one click, fully or partly; prices are kept from the quote | M |
| FR-QUO-05 | Revise a quotation (new revision number, history kept) | S |
| FR-QUO-06 | Print/PDF/WhatsApp/email the quotation | M |

### 3.9 Sales orders, invoices and delivery (INV-S)

For wholesale customers who order in advance, pay later, or receive delivery.

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-SO-01 | Sales order: reserves stock, can be partly delivered and partly invoiced | S |
| FR-SO-02 | Delivery challan / dispatch note with driver, vehicle, route; stock leaves on dispatch | S |
| FR-SO-03 | Sales invoice (back-office, A4) with payment terms (cash, 7/15/30 days) and due date | M |
| FR-SO-04 | Tax invoice format for registered buyers with buyer NTN/STRN | M |
| FR-SO-05 | Order booker app view: salesperson takes orders on mobile at the customer's shop | C |
| FR-SO-06 | Delivery status: pending, dispatched, delivered, returned | S |

### 3.10 Customers and receivables (CUS)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-CUS-01 | Customer record: name, business name, phone(s), WhatsApp, email, address, area/route, CNIC, NTN, STRN, registration status (registered/unregistered), price tier, credit limit, payment terms, notes | M |
| FR-CUS-02 | Customer ledger (khata): every invoice, return, payment and adjustment with running balance | M |
| FR-CUS-03 | Receive payment against one or many invoices (allocation), or on account; payment receipt printed/shared | M |
| FR-CUS-04 | Ageing report (0–30, 31–60, 61–90, 90+ days) and overdue list | M |
| FR-CUS-05 | Customer statement for a date range — PDF/WhatsApp | M |
| FR-CUS-06 | Opening balances import | M |
| FR-CUS-07 | Customer groups and areas/routes for reporting and price tiers | S |
| FR-CUS-08 | Payment reminder via WhatsApp/SMS link with balance | S |
| FR-CUS-09 | Cheque management: post-dated cheques, deposit, cleared, bounced (re-opens balance) | S |

### 3.11 Suppliers and purchasing (PUR)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-PUR-01 | Supplier record: name, contact, address, NTN/STRN, payment terms, opening balance | M |
| FR-PUR-02 | Purchase order: items, units, cost, expected date; statuses draft, sent, partly received, received, closed, cancelled | M |
| FR-PUR-03 | Goods receipt (GRN) against a PO or direct; partial receipts; adds stock and updates average cost | M |
| FR-PUR-04 | Purchase invoice (bill) linked to GRN, with supplier invoice number, tax, freight/landed costs allocated to item cost | M |
| FR-PUR-05 | Purchase return / debit note to supplier, reduces stock and payable | M |
| FR-PUR-06 | Supplier ledger, payments (full, partial, against bills), ageing of payables | M |
| FR-PUR-07 | Reorder list → draft POs grouped by preferred supplier | S |
| FR-PUR-08 | Last purchase price and supplier price history on the PO screen | S |
| FR-PUR-09 | Input sales tax on purchase invoices recorded for the tax report | S |

### 3.12 Cash register, shifts and expenses (CSH)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-CSH-01 | Open shift with opening float; one open shift per terminal | M |
| FR-CSH-02 | Cash in / cash out (petty cash, bank deposit) with reason during the shift | M |
| FR-CSH-03 | Close shift: blind cash count by denomination, expected vs counted, variance recorded, Z-report printed | M |
| FR-CSH-04 | X-report (mid-shift summary) without closing | S |
| FR-CSH-05 | Expenses: category, amount, payment method, paid from (register, bank), attachment photo | M |
| FR-CSH-06 | Bank and wallet accounts with balances and transfers between them | S |
| FR-CSH-07 | Day-end closing per branch summarising all shifts | S |

### 3.13 Tax, discounts and charges (TAX)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-TAX-01 | Tax categories (standard 18%, reduced, zero-rated, exempt, third schedule/retail price) with rates as settings | M |
| FR-TAX-02 | Further tax on supplies to unregistered persons and withholding tax as configurable rules | S |
| FR-TAX-03 | Tax-inclusive or exclusive pricing; line-level tax computation with rounding rules matching FBR | M |
| FR-TAX-04 | Additional charges on invoices: delivery, packing, loading, with or without tax | S |
| FR-TAX-05 | Sales tax summary report (output tax, input tax, by rate) for return filing | M |

### 3.14 Reports and dashboard (RPT)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-RPT-01 | Dashboard: today's sales, profit, number of bills, average bill, cash in hand, receivables, payables, low stock, top products, sales trend | M |
| FR-RPT-02 | Every report filterable by date range, branch, terminal, user, customer/supplier, category, product; export to Excel/CSV and PDF | M |
| FR-RPT-03 | Full report list in Section 7.2 | M |
| FR-RPT-04 | Profit hidden from roles without permission | M |
| FR-RPT-05 | Scheduled email of daily summary to Owner | C |

### 3.15 Settings and configuration (SET)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-SET-01 | General: currency format, rounding, date format, time zone (Asia/Karachi), default tax mode | M |
| FR-SET-02 | POS behaviour: negative stock, auto-print, default customer, require customer for credit, return window, discount limits per role | M |
| FR-SET-03 | Payment methods: enable/disable, name, FBR payment mode mapping | M |
| FR-SET-04 | Print templates (Section 3.7) | M |
| FR-SET-05 | FBR integration settings (Section 4) | M |
| FR-SET-06 | Bilingual printing (English + Urdu product names) | S |
| FR-SET-07 | Notification settings (low stock, overdue, daily summary) | S |

### 3.16 Audit, data and backup (AUD)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-AUD-01 | Audit log of every create, update, delete, void, reprint, price override, permission change and login: who, when, what changed (before/after), from which terminal | M |
| FR-AUD-02 | Soft delete for master data; posted documents cannot be deleted, only reversed | M |
| FR-AUD-03 | Owner can export all data (CSV/JSON) at any time | M |
| FR-AUD-04 | Automated daily database backups with 30-day retention and tested restore | M |

## 4. FBR integration (FBR)

The business owner connects the system to their own FBR account by entering their credentials in Settings; from then on every taxable sale and return is reported to FBR in real time and the bill prints FBR's invoice number and QR code. FBR integration is optional and switchable per business and per terminal; the system works fully without it.

### 4.1 Integration modes

FBR runs two channels, and the system must support both because a business may fall under either:

| Mode | Who uses it | What the system sends | What comes back |
| --- | --- | --- | --- |
| POS Integration (fiscalisation) | Tier-1 retailers selling at a counter | Each counter sale, with the registered FBR POS ID | FBR fiscal invoice number for the receipt and QR code |
| Digital Invoicing (DI) via PRAL | Every sales-tax-registered person, including wholesalers ([overview](https://bacoconsultants.com/blogs/fbr-digital-invoicing-2026-registration-integration-penalties)) | Each sales invoice, debit/credit note as JSON over a REST API ([PRAL DI API v1.12](https://download1.fbr.gov.pk/Docs/20257301172130815TechnicalDocumentationforDIAPIV1.12.pdf)) | Validation result, FBR invoice reference number (IRN) and QR data |

A wholesaler such as SGA Balloons will mainly use DI; POS Integration covers retail counters. Which channel applies must be confirmed with the business's tax advisor.

### 4.2 Connection and settings

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-FBR-01 | FBR settings screen (Owner only): enable/disable, mode (POS / DI / both), environment (sandbox / production), seller NTN, STRN, business name, province, address | M |
| FR-FBR-02 | Store the PRAL/FBR security token (bearer token) and, for POS mode, the FBR POS ID per terminal; encrypted at rest, masked in the UI, never sent to the browser | M |
| FR-FBR-03 | "Test connection" button that calls the sandbox/production validate endpoint and shows the result | M |
| FR-FBR-04 | Sync FBR reference data on demand and on a schedule: provinces, HS codes, UoMs, sale types/scenarios, tax rates, SRO schedules | M |
| FR-FBR-05 | Map system data to FBR codes: product → HS code and FBR UoM; tax category → FBR rate and sale type; payment method → FBR payment mode code | M |
| FR-FBR-06 | Sandbox scenario test pack: run the required PRAL test scenarios from inside the app and record pass/fail before production switch-on | S |
| FR-FBR-07 | Buyer verification: check a buyer's NTN/STRN registration status through FBR's registration (STATL) service before invoicing | S |

### 4.3 Submission flow

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-FBR-10 | Before posting, validate locally that all FBR-required fields are present (HS code, UoM, rate, buyer type, buyer NTN/CNIC when required) and block with a clear message if not | M |
| FR-FBR-11 | On sale completion, the server sends the invoice to FBR (validate, then post) and stores the returned IRN / fiscal number, status and full response | M |
| FR-FBR-12 | Returns are sent as credit/debit notes referencing the original FBR invoice number | M |
| FR-FBR-13 | If FBR is unreachable or times out: the sale completes, is marked "FBR pending", goes into a retry queue with back-off, and the bill can be reprinted with the IRN once received; the cashier is warned | M |
| FR-FBR-14 | Idempotency: the same invoice is never reported twice (unique local reference per submission) | M |
| FR-FBR-15 | FBR log screen: every request/response, status (pending, accepted, rejected, failed), error message, retry and manual resubmit, filter by date and status | M |
| FR-FBR-16 | Rejected invoices are flagged on the dashboard for correction (correct the data, cancel/re-issue as the rules allow) | M |
| FR-FBR-17 | Respect FBR's cancel/edit window for posted invoices (currently 72 hours under Sales Tax General Order 01 of 2026, [source](https://lookuptax.com/docs/einvoicing/fbr-digital-invoicing-pakistan)); the window length is a setting | S |
| FR-FBR-18 | Daily reconciliation report: invoices posted locally vs accepted by FBR, with differences | S |
| FR-FBR-19 | Manual mode fallback: export the invoice payload as JSON for upload on the PRAL portal | C |

### 4.4 Printed FBR fields

When an invoice is fiscalised, both the POS slip and the A4 layout must print the FBR-mandated content. For POS-integrated receipts, SRO 1006(I)/2021 requires ([summary](https://github.com/Tier3-Pk/FBR-POS-INTEGRATION-SERVICES)):

- POS registration number, seller name, NTN/STRN
- Item-wise quantity, price, tax rate (0% for exempt items), tax amount, discounts
- Total sale value, tax charged, the Re. 1 POS service fee per invoice, total payable and total received
- FBR fiscal invoice number, FBR POS logo, a verifiable QR code (7 × 7 mm) and the Tax Asaan / SMS 9966 verification line

For DI invoices: FBR invoice reference number, QR code, FBR digital invoicing logo, seller and buyer details, and sales tax, further tax and withheld tax amounts. Exact field lists are kept as a configurable template because FBR revises them.

### 4.5 Security of FBR data

- All FBR calls are server-to-server from the Vercel API functions; the browser never calls FBR directly
- Tokens can be rotated by the Owner; every change is audit-logged
- FBR responses are stored for at least 6 years for tax record-keeping

## 5. Data model overview

The core is a set of master records and a set of posted documents; stock and money balances are always derived from document lines and ledger entries, never edited directly.

| Group | Entities | Key fields / notes |
| --- | --- | --- |
| Organisation | Business, Branch, Location (store/warehouse), Terminal, DocumentSeries, Setting | tenant\_id on every table for future multi-business hosting |
| Users | User, Role, Permission, RolePermission, UserBranch, Session, LoginLog | PIN hash, active flag |
| Catalogue | Category, Brand, Product, ProductVariant (SKU), Attribute, AttributeValue, Unit, ProductUnit (conversion, barcode, price), PriceList, PriceListItem, TaxCategory | HS code and FBR UoM on Product/ProductUnit |
| Inventory | StockLedgerEntry, StockBalance (cached per SKU × location), StockAdjustment(+Line), StockTransfer(+Line), StockCount(+Line), Batch, SerialNumber | ledger is append-only; balance rebuilt from ledger |
| Parties | Customer, CustomerGroup, Area/Route, Supplier, Contact, PartyLedgerEntry | credit limit, terms, NTN/STRN/CNIC, registered flag |
| Sales | Quotation(+Line), SalesOrder(+Line), DeliveryChallan(+Line), SalesInvoice(+Line), SalesReturn(+Line), HeldSale | invoice status: draft, posted, returned (partly/fully) |
| Purchasing | PurchaseOrder(+Line), GoodsReceipt(+Line), PurchaseInvoice(+Line), PurchaseReturn(+Line), LandedCost |  |
| Money | Payment, PaymentAllocation, PaymentMethod, Account (cash/bank/wallet), Cheque, Expense, ExpenseCategory, Shift, CashMovement | amounts in paisa (integer) |
| FBR | FbrConfig, FbrTerminalConfig, FbrReferenceData (HS codes, UoM, rates, scenarios), FbrSubmission (request, response, status, IRN, retries) | one FbrSubmission per invoice/return attempt |
| System | AuditLog, Attachment, Notification, PrintTemplate, ImportJob |  |

Rules that apply across entities:

- Every document line stores the price, discount, tax rate and cost at the time of the transaction (no recalculation from current prices)
- Quantities are stored in the base unit plus the unit and factor used on the line
- Posted documents and ledger entries are immutable; corrections create new linked documents
- All tables carry created\_at/by and updated\_at/by; deletions of master data are soft deletes

## 6. Non-functional requirements

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-PRF-01 | Performance | Product search/scan result in under 300 ms for a catalogue of 20,000 SKUs |
| NFR-PRF-02 | Performance | Sale completion (post + stock + ledger) under 1.5 s excluding FBR round-trip; FBR call must not block the cashier for more than 5 s |
| NFR-PRF-03 | Performance | Reports up to 100,000 invoice lines return in under 10 s; larger exports run as background jobs |
| NFR-PRF-04 | Scale | 20 concurrent terminals and 10 back-office users per business without degradation |
| NFR-AVL-01 | Availability | 99.5% monthly uptime for the hosted service |
| NFR-AVL-02 | Recovery | Daily backups + point-in-time recovery; RPO ≤ 15 min, RTO ≤ 4 h |
| NFR-AVL-03 | Offline | POS keeps working through internet outages of up to 8 hours: catalogue, prices and customers cached locally (IndexedDB); sales queued with locally reserved invoice numbers per terminal and synced in order when back online; credit sales over limit and returns need connection |
| NFR-SEC-01 | Security | HTTPS everywhere; secure, HTTP-only session cookies or short-lived JWT + refresh token |
| NFR-SEC-02 | Security | Authorisation checked on the server for every API call (never only hidden in the UI); row-level isolation by tenant and branch |
| NFR-SEC-03 | Security | Secrets (DB, FBR tokens) in Vercel environment variables / encrypted columns; OWASP Top 10 protections; rate-limited login |
| NFR-SEC-04 | Privacy | Customer CNIC and phone visible only to permitted roles; masked on printouts unless required |
| NFR-INT-01 | Integrity | All posting operations run in a database transaction: invoice, stock, ledger and payment succeed or fail together |
| NFR-INT-02 | Integrity | Concurrent sales of the last unit cannot both succeed when negative stock is disabled |
| NFR-USA-01 | Usability | Full POS flow usable by keyboard and scanner only; touch targets ≥ 44 px on tablets |
| NFR-USA-02 | Usability | A new cashier can complete a sale after 15 minutes of training |
| NFR-USA-03 | Usability | Clear error messages in plain language, including FBR errors translated from codes |
| NFR-MNT-01 | Maintainability | Modular codebase per module; automated tests for pricing, tax, stock and posting logic (≥ 80% coverage on these) |
| NFR-MNT-02 | Maintainability | Database migrations versioned; preview deployments on Vercel for every change; separate staging with FBR sandbox |
| NFR-CMP-01 | Compliance | Records kept at least 6 years; FBR rules and rates configurable without a code release |
| NFR-OBS-01 | Observability | Error tracking and logs for API functions; alert when FBR failure rate exceeds 5% in an hour |

## 7. Interfaces, reports and acceptance

### 7.1 External interfaces

| Interface | Purpose | Notes |
| --- | --- | --- |
| FBR / PRAL DI API | Post and validate invoices, reference data | REST/JSON, bearer token, sandbox + production |
| FBR POS Integration API | Fiscalise counter sales | POS ID per terminal |
| Barcode scanner | Item entry | Keyboard-wedge input, no driver |
| Thermal and A4 printers | Bills, invoices, labels | Browser print; optional ESC/POS |
| Cash drawer | Open on cash sale | Via receipt printer kick |
| WhatsApp / SMS / email | Share bills, statements, reminders | wa.me links first; WhatsApp Business API and SMS gateway later |
| CSV / Excel | Import products, customers, opening stock; export reports | Template files provided |
| System REST API | Future mobile app, e-commerce, accounting sync | Documented, token-protected |

### 7.2 Report catalogue

| Group | Reports |
| --- | --- |
| Sales | Daily sales summary, sales by product / category / brand / customer / salesperson / branch / terminal / hour, invoice register, discount report, voided and reprinted bills, returns report, top and slow sellers |
| Profit | Gross profit by invoice, product, category, customer; profit and loss summary (sales − COGS − expenses) |
| Inventory | Stock on hand, stock valuation, stock ledger, low stock / reorder, dead stock (no sale in N days), adjustments, transfers, count variances, expiry |
| Purchasing | Purchase register, by supplier / product, pending POs, GRN not invoiced, purchase returns |
| Receivables / payables | Customer and supplier ledgers, ageing, outstanding balances, statements, collections by date, cheques due |
| Cash | Shift (X/Z) reports, cash variance, payments by method, expenses by category, cash book, bank book |
| Tax and FBR | Sales tax summary (output/input), FBR submission status, rejected/pending FBR invoices, FBR reconciliation |
| Audit | Audit log, login history, price changes, manager overrides |

### 7.3 Acceptance criteria (system level)

1. A cashier can scan items, apply a discount, take split payment (cash + wallet), and print an 80 mm slip in under 30 seconds.
2. The same sale can be reprinted as A4, marked duplicate, with identical totals.
3. Stock on hand after any sequence of sales, returns, purchases, transfers and adjustments equals opening stock plus the sum of ledger movements.
4. A partial return of a fiscalised invoice produces a credit note accepted by the FBR sandbox, linked to the original IRN.
5. With the internet cut, the terminal completes and prints sales; on reconnection all are synced and fiscalised with no duplicates.
6. A cashier without permission cannot give a discount above their limit, see profit, or delete any posted document, even by calling the API directly.
7. Customer ledger balance equals invoices − returns − payments ± adjustments for any date range.
8. A purchase receipt updates weighted average cost correctly and is reflected in profit reports.

### 7.4 Items commonly missed (included above)

Multi-unit selling (piece/pack/carton), price tiers for wholesale, customer credit limits and khata, held sales, shift cash counts, manager overrides, gap-free numbering, offline sales, FBR retry queue, duplicate-print marking, audit log, opening balances import, cheque tracking, landed cost, delivery challans, dead-stock report, data export and backups.

### 7.5 Future enhancements

- Double-entry accounting (chart of accounts, journals, trial balance, balance sheet)
- Mobile order-booker app with route planning for field sales
- Customer self-service portal (view statement, re-order)
- E-commerce / WhatsApp catalogue ordering synced with stock
- Provincial tax authority integrations (SRB for Sindh services) if needed
- Payment gateway links (JazzCash/Easypaisa/Raast QR) for remote collection
- Multi-business SaaS hosting with subscription billing

### 7.6 SGA Balloons customisation (later)

Placeholder for the next revision: balloon attributes (size, colour, finish, print/design), packaging units (pieces per pack, packs per carton), wholesale price tiers per customer type, delivery areas across Karachi, and which FBR channel applies to SGA.

### Sources

- [PRAL Technical Specification for DI API v1.12](https://download1.fbr.gov.pk/Docs/20257301172130815TechnicalDocumentationforDIAPIV1.12.pdf)
- [FBR Digital Invoicing — Pakistan (mandate status, Oct 2026)](https://lookuptax.com/docs/einvoicing/fbr-digital-invoicing-pakistan)
- [FBR Digital Invoicing 2026: registration and integration](https://bacoconsultants.com/blogs/fbr-digital-invoicing-2026-registration-integration-penalties)
- [FBR POS integration — SRO 1006(I)/2021 receipt fields](https://github.com/Tier3-Pk/FBR-POS-INTEGRATION-SERVICES)
- [Example DI + POS fiscal integration (ERPNext)](https://github.com/kodlyft/di)
