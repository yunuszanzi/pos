import { Hono } from "hono";
import { authenticate } from "./lib/auth";
import { isTransientConflict } from "./lib/dbErrors";
import { apiError } from "./lib/http";
import { HTTPException } from "hono/http-exception";
import { auditRoutes } from "./modules/audit/routes";
import { authRoutes } from "./modules/auth/routes";
import { catalogueRoutes } from "./modules/catalogue/routes";
import { chequeRoutes } from "./modules/customers/cheques";
import { billRoutes } from "./modules/purchasing/bills";
import { payablesRoutes } from "./modules/purchasing/payables";
import { reorderRoutes } from "./modules/purchasing/reorder";
import { quotationRoutes } from "./modules/quotations/routes";
import { challanRoutes } from "./modules/sales/challans";
import { salesInvoiceRoutes } from "./modules/sales/invoices";
import { salesOrderRoutes } from "./modules/sales/orders";
import { purchasingRoutes } from "./modules/purchasing/routes";
import { suppliersRoutes } from "./modules/suppliers/routes";
import { customerLedgerRoutes } from "./modules/customers/ledger";
import { returnRoutes } from "./modules/returns/routes";
import { customersRoutes } from "./modules/customers/routes";
import { inventoryRoutes } from "./modules/inventory/routes";
import { orgRoutes } from "./modules/org/routes";
import { posRoutes } from "./modules/pos/routes";
import { productsRoutes } from "./modules/products/routes";
import { settingsRoutes } from "./modules/settings/routes";
import { reportsRoutes } from "./modules/reports/routes";
import { salesRoutes } from "./modules/sales/routes";
import { shiftsRoutes } from "./modules/shifts/routes";
import { usersRoutes } from "./modules/users/routes";

export const app = new Hono();

app.get("/api/health", (context) => context.json({ status: "ok" }));
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
app.route("/api/v1", salesInvoiceRoutes);
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
  console.error("Unhandled API error", error);
  return context.json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } }, 500);
});
