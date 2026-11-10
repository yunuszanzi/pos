# Security review (v1.0)

Against the OWASP Top 10 (2021) and SRS NFR-SEC-01 to 04. Each line says what protects the system and what proves it. "Test" means an
automated test that keeps running (`tests/integration/security.test.ts` unless another file is named). What was **not** checked is stated at the end.

| # | Risk | What protects us | Evidence |
|---|---|---|---|
| A01 | Broken access control | Every `/api/v1` route needs a signed-in person (401 without) and a permission (403 without). A person with **no** permissions can reach only nine routes, each listed with its reason, and the test fails when a new route is not on that list. Reports, document shares and the dashboard check their own permission inside. Every query is scoped by the business of the signed-in person; a stranger's id gives 404. | Test: all 243 routes. Per-feature tests include cross-business 404s (for example `stock-transfers-api`, `stock-counts-api`, `offline-sales-api`). |
| A01 | Direct database access | Row-level security is on in every table; tables for the shop's records have no grants to the browser roles at all, so a stolen sign-in cannot read or change anything through the public database interface. The server uses its own connection. | Test: signed-in and anonymous reads and writes through the public interface return nothing, in all 83 tables. |
| A02 | Cryptographic failures | HTTPS with HSTS (preload). Passwords are Supabase Auth's (bcrypt). The FBR token is AES-256-GCM encrypted with `APP_ENCRYPTION_KEY`, never sent to the browser or the audit log. PINs are hashed and attempts limited. The data export leaves out PIN hashes and the encrypted token. | `fbr-settings-api.test` (token never returned), `export-api.test`, `pin.test`, headers in `vercel.json` |
| A03 | Injection | All SQL is parameterised (Drizzle and tagged templates). The few places that build SQL text use values already checked (UUIDs, table names matched to a fixed pattern and the real table list). Text from files is checked against forms' own rules. CSV exports neutralise cells that start like a formula. | `csv.test`, `export-api.test`, `party-import-api.test` |
| A03 | Cross-site scripting | React escapes output; the one place HTML could be built is not used (no `dangerouslySetInnerHTML`). The QR code is drawn as an image, never inserted as markup. A strict Content-Security-Policy (no inline script, no eval) is sent with every page. | Test: the real build runs a sale under the production policy with no blocked resource (`tests/pwa`). |
| A04 | Insecure design | Posting is transactional with idempotency keys; posted documents are immutable (database triggers); stock and ledgers are append-only with guard triggers; money is integer paisa. | `sales-database.test`, `database-security.test`, `stock-ledger.test` |
| A05 | Security misconfiguration | Security headers on the API (`nosniff`, no framing, no referrer, no caching) and on pages (CSP, HSTS, permissions policy). The scheduled-job endpoints refuse everything without `CRON_SECRET` and are checked to be the only open routes besides the health check and share links. `FBR_ADAPTER=mock` must be unset in production. | Test: public routes are exactly the expected ones; headers. |
| A06 | Vulnerable components | Dependencies are pinned by `package-lock.json`; CI installs from it. `npm audit` should be run before go-live and monthly (see below). | Not automated here |
| A07 | Identification and authentication failures | Supabase Auth sessions; inactivity expiry is a setting; manager approval and PIN switching are rate-limited per person; deactivated users are refused at once. Login rate limiting is Supabase Auth's. | `pin.test`, `user-management.test`, `sign-in.spec` |
| A08 | Software and data integrity | CI runs all tests on every change. Migrations are versioned and applied in order, and an upgrade from an earlier version is tested. The service worker never touches `/api`. | `migrations.test`, `migration-upgrade.test` |
| A09 | Logging and monitoring failures | Audit log of changes, voids, reprints, overrides and exports; FBR attempt log (append-only). Unhandled errors go to Sentry when `SENTRY_DSN` is set; FBR failing in more than 5% of an hour's calls raises an alert. | `monitoring.test`, `foundation-acceptance.test` |
| A10 | Server-side request forgery | The server calls out to one place only: FBR's address, chosen by the environment setting, not by anything a user types. Share links and attachments are read from our own database and storage. | `fbr-settings-api.test` |

## Customer data (NFR-SEC-04)

CNIC and phone numbers appear only on screens that need `customers.view` or a document the person may open. **Printouts are not masked.** A bill shows
what the customer asked to be on it (name, and tax numbers for a tax invoice). This is a known gap; see `docs/go-live.md`.

## Not checked, and why

- **A penetration test by a third party.** Nothing here replaces one. Do it before the first client goes live.
- **The hosting.** Vercel and Supabase settings (network restrictions, paid-plan backups, two-factor on the owner accounts) are set at go-live.
- **`npm audit`.** Run `npm audit --omit=dev` before go-live and fix anything high or critical. It needs the internet, which this review did not use.
- **Denial of service.** Request-size limits and rate limits beyond sign-in and PINs are the platform's.
