/**
 * Modules on the roadmap (docs/technical-plan.md, section 6) that have no page yet. The menu lists them as
 * "Under development" and does not link them, so nobody lands on an empty page.
 * When a version ships a module, delete its entry here and add the route to appRoutes in App.tsx.
 */
export type PlannedModule = { label: string; version: string };

export const plannedModules: PlannedModule[] = [
  { label: "Customers", version: "v0.4" },
  { label: "Returns & exchanges", version: "v0.4" },
  { label: "Suppliers", version: "v0.5" },
  { label: "Purchasing", version: "v0.5" },
  { label: "Quotations & orders", version: "v0.6" },
  { label: "Delivery challans", version: "v0.6" },
  { label: "Reports & dashboard", version: "v0.7" },
  { label: "Expenses & accounts", version: "v0.7" },
  { label: "FBR integration", version: "v0.8" },
  { label: "Transfers & stock counts", version: "v0.9" },
];
