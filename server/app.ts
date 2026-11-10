import { Hono } from "hono";
import { authenticate } from "./lib/auth";
import { isTransientConflict } from "./lib/dbErrors";
import { apiError } from "./lib/http";
import { HTTPException } from "hono/http-exception";
import { auditRoutes } from "./modules/audit/routes";
import { dashboardRoutes } from "./modules/reports/dashboard";
import { fbrLogRoutes } from "./modules/fbr/log";
import { fbrSettingsRoutes } from "./modules/fbr/settings";
import { jobRoutes } from "./modules/jobs/routes";
import { dayClosingRoutes } from "./modules/shifts/dayClosing";
import { authRoutes } from "./modules/auth/routes";
import { catalogueRoutes } from "./modules/catalogue/routes";
import { chequeRoutes } from "./modules/customers/cheques";
import { billRoutes } from "./modules/purchasing/bills";
import { payablesRoutes } from "./modules/purchasing/payables";
import { reorderRoutes } from "./modules/purchasing/reorder";
import { quotationRoutes } from "./modules/quotations/routes";
import { accountRoutes } from "./modules/accounts/routes";
import { expenseRoutes } from "./modules/expenses/routes";
import { countRoutes } from "./modules/inventory/counts";
import { transferRoutes } from "./modules/inventory/transfers";
import { partyImportRoutes } from "./modules/parties/import";
import { challanRoutes } from "./modules/sales/challans";
import { offlineSaleRoutes } from "./modules/sales/offline";
import { salesInvoiceRoutes } from "./modules/sales/invoices";
import { publicRoutes, shareRoutes } from "./modules/shares/routes";
import { salesOrderRoutes } from "./modules/sales/orders";
import { purchasingRoutes } from "./modules/purchasing/routes";
import { suppliersRoutes } from "./modules/suppliers/routes";
import { customerLedgerRoutes } from "./modules/customers/ledger";
import { returnRoutes } from "./modules/returns/routes";
import { customersRoutes } from "./modules/customers/routes";
import { inventoryRoutes } from "./modules/inventory/routes";
import { orgRoutes } from "./modules/org/routes";
import { secureHeaders } from "hono/secure-headers";
import { captureError } from "./lib/monitoring";
import { posRoutes } from "./modules/pos/routes";
import { productsRoutes } from "./modules/products/routes";
import { settingsRoutes } from "./modules/settings/routes";
import { reportsRoutes } from "./modules/reports/routes";
import { salesRoutes } from "./modules/sales/routes";
import { shiftsRoutes } from "./modules/shifts/routes";
import { usersRoutes } from "./modules/users/routes";

export const app = new Hono();

// Headers for every answer: no guessing at content types, no framing, no referrer. What the API says about money, stock and people is
// never kept by a browser or a shared proxy (it is private, and it changes).
app.use("*", secureHeaders({ xFrameOptions: "DENY", referrerPolicy: "no-referrer" }));
app.use("/api/*", async (context, next) => {
  await next();
  if (!context.req.path.startsWith("/api/health")) context.header("Cache-Control", "no-store");
});

app.get("/api/health", (context) => context.json({ status: "ok" }));
// The one place without sign-in: reading a document through a share link (the unguessable token is the key).
app.route("/api/public", publicRoutes);
// Scheduled work (FBR retries): behind a secret of its own instead of a sign-in.
app.route("/api/jobs", jobRoutes);
app.use("/api/v1/*", authenticate);
app.route("/api/v1", authRoutes);
app.route("/api/v1", orgRoutes);
app.route("/api/v1", usersRoutes);
app.route("/api/v1", settingsRoutes);
app.route("/api/v1", auditRoutes);
app.route("/api/v1", catalogueRoutes);
app.route("/api/v1", productsRoutes);
app.route("/api/v1", inventoryRoutes);
app.route("/api/v1", shiftsRoutes);
app.route("/api/v1", salesRoutes);
app.route("/api/v1", posRoutes);
app.route("/api/v1", reportsRoutes);
app.route("/api/v1", partyImportRoutes);
app.route("/api/v1", customersRoutes);
app.route("/api/v1", customerLedgerRoutes);
app.route("/api/v1", chequeRoutes);
app.route("/api/v1", suppliersRoutes);
app.route("/api/v1", purchasingRoutes);
app.route("/api/v1", billRoutes);
app.route("/api/v1", payablesRoutes);
app.route("/api/v1", reorderRoutes);
app.route("/api/v1", quotationRoutes);
app.route("/api/v1", salesOrderRoutes);
app.route("/api/v1", challanRoutes);
app.route("/api/v1", offlineSaleRoutes);
app.route("/api/v1", transferRoutes);
app.route("/api/v1", countRoutes);
app.route("/api/v1", salesInvoiceRoutes);
app.route("/api/v1", shareRoutes);
app.route("/api/v1", accountRoutes);
app.route("/api/v1", expenseRoutes);
app.route("/api/v1", dashboardRoutes);
app.route("/api/v1", dayClosingRoutes);
app.route("/api/v1", fbrSettingsRoutes);
app.route("/api/v1", fbrLogRoutes);
app.route("/api/v1", returnRoutes);

app.notFound((context) => apiError(context, 404, "NOT_FOUND", "API route not found"));
app.onError((error, context) => {
  if (isTransientConflict(error)) {
    return context.json({ error: { code: "BUSY", message: "Someone else changed the same thing at the same moment. Nothing was saved; please try again." } }, 409);
  }
  // A request the framework itself refused (a body that is not JSON, for example) is the caller's mistake, not ours.
  if (error instanceof HTTPException && error.status >= 400 && error.status < 500) {
    return context.json({ error: { code: "BAD_REQUEST", message: "The request could not be read. Send a JSON body." } }, error.status);
  }
  void captureError(error, { path: context.req.path, method: context.req.method });
  return context.json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } }, 500);
});
