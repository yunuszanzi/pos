import { Hono } from "hono";
import { authenticate } from "./lib/auth";
import { apiError } from "./lib/http";
import { auditRoutes } from "./modules/audit/routes";
import { authRoutes } from "./modules/auth/routes";
import { orgRoutes } from "./modules/org/routes";
import { settingsRoutes } from "./modules/settings/routes";
import { usersRoutes } from "./modules/users/routes";

export const app = new Hono();

app.get("/api/health", (context) => context.json({ status: "ok" }));
app.use("/api/v1/*", authenticate);
app.route("/api/v1", authRoutes);
app.route("/api/v1", orgRoutes);
app.route("/api/v1", usersRoutes);
app.route("/api/v1", settingsRoutes);
app.route("/api/v1", auditRoutes);

app.notFound((context) => apiError(context, 404, "NOT_FOUND", "API route not found"));
app.onError((error, context) => {
  console.error("Unhandled API error", error);
  return context.json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } }, 500);
});
