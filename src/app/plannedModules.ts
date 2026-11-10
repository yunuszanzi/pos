/**
 * Modules on the roadmap (docs/technical-plan.md, section 6) that have no page yet. The menu lists them as
 * "Under development" and does not link them, so nobody lands on an empty page.
 * When a version ships a module, delete its entry here and add the route to appRoutes in App.tsx.
 */
export type PlannedModule = { label: string; version: string };

// Nothing is planned without a page now: every module on the v0.x roadmap has shipped. Add an entry here when a new one is announced.
export const plannedModules: PlannedModule[] = [];
