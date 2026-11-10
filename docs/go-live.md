# Go-live checklist and known gaps (v1.0)

What has to happen before the first client (SGA Balloons, Karachi) sells on the live system. Items that need an account, a payment or a
person, rather than code, are marked **You**. Nothing here has been done for you: the code is ready, the hosting and FBR steps are not.

## 1. Hosting (You)

- [ ] Move Supabase to a paid plan: daily backups with 30-day retention and point-in-time recovery (FR-AUD-04, NFR-AVL-02).
- [ ] Move Vercel to a paid plan if the free plan's limits or its once-a-day cron limit get in the way (the retry job is called from an outside scheduler instead; see `docs/runbook.md`).
- [ ] Turn on two-factor sign-in for the owners of the Vercel, Supabase, GitHub and Sentry accounts.
- [ ] Create a staging Supabase project and Vercel preview environment (NFR-MNT-02). Set the FBR sandbox token there.
- [ ] Set the environment variables listed in the runbook in Vercel. **Leave `FBR_ADAPTER` unset.**
- [ ] Start the scheduler for `/api/jobs/fbr-retry` (every minute) and `/api/jobs/fbr-sync` (daily).
- [ ] Create a Sentry project and set `SENTRY_DSN`; create a webhook for alerts and set `ALERT_WEBHOOK_URL`. Send a test error and check it arrives (that path was built to Sentry's
      documented format but has not yet been seen by a real project).

## 2. Safety checks before the first sale (You)

- [ ] Run the restore drill in `docs/runbook.md` and keep the written result.
- [ ] Run `npm audit --omit=dev`; fix anything high or critical.
- [ ] Have someone outside the project test it for security (`docs/security-review.md` lists what was not covered).
- [ ] Run the sale-to-print walkthrough in `docs/user-guide.md` on the real printers (80 mm slip and A4).

## 3. FBR (You, with the client's FBR account)

The FBR adapter has only ever talked to the built-in fake. It was written from PRAL's published Digital Invoicing specification **without a real token**.

- [ ] Get the client's sandbox token from their FBR account.
- [ ] In FBR settings: sandbox, token, seller details, map every tax category to its FBR sale type, and every product's HS code and unit.
- [ ] Press "Test connection", then run all nine scenarios. **Fix whatever the real answers show** (field names, error shapes, how the number and QR code arrive) in `server/fbr/adapters/digitalInvoicing.ts`.
- [ ] Make a real sale and a real return in the sandbox; check the number and QR on the printed bill, and the return as a debit note.
- [ ] Ask PRAL (or test) what happens when a post times out after FBR recorded the invoice: a retry could report it twice. If FBR can look an invoice up by our number, add that check before retrying.
- [ ] Only then switch to production (the screen asks you to confirm if any scenario has not passed).

## 4. Loading the client's data

In this order, each with its "check, then import" screen and a template to download:

1. Products and prices (Products, Import). Then opening stock (Stock, Opening stock). Count the shelves first; load what you counted.
2. Customers (Customers, Import customers), then their opening balances (Customers, Opening balances).
3. Suppliers (Suppliers, Import suppliers), then opening payables (Suppliers, Opening payables).
4. Check: stock valuation against the count; customers' total against the old khata book; suppliers' total against the old payables.

## 5. People

- [ ] Create the users and their roles; set PINs at the tills.
- [ ] Train the cashiers with the cashier chapter of `docs/user-guide.md`, on the real tills, with a few practice sales, a return, closing a shift, and the offline banner.
- [ ] Train the manager on counts, transfers, returns, the FBR log and the "Offline sales to review" page.
- [ ] Decide who watches the dashboard's FBR card each day.

## Known gaps (what the product does not do yet)

From `docs/requirements-trace.md`. None blocks a first go-live, but the owner should know.

| Gap | Effect |
|---|---|
| FBR POS fiscal mode not built | Digital Invoicing (online) only. If the client must use a fiscal POS device, that is new work. |
| Further tax for unregistered buyers is not calculated | The FBR payload sends 0. Check with the client's accountant whether it applies to their sales. |
| FIFO costing, per-product negative stock | Weighted average and a business-wide setting only. |
| Exchange in one flow | Do a return, then a new sale. |
| Tags, favourites and quick keys, product images on tiles | Not built. |
| Email and SMS sending; real Excel and PDF files | Share by WhatsApp link; open CSV in Excel; save as PDF from the print dialog. |
| Editable print templates; printouts do not mask CNIC or phone | Six fixed layouts. |
| Closing a shift asks for one counted total, not a count by note and coin | The variance is the same; the breakdown is not recorded from the screen. |
| Batch and expiry tracking; silent printing | Not built (a browser cannot print without its dialog unless started in kiosk-printing mode). |
| Large exports as background jobs; a 20-terminal load test | A 100,000-line export finishes in seconds here; nothing larger was run. |
| Offline limits | Credit sales, returns and closing a shift need a connection; the slip's reference stands in for the invoice number until the sale is sent (see v0.9 in `docs/technical-plan.md`). |
