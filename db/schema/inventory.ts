import { bigint, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./system";

const businessId = () => uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" });

/** Append-only (database trigger). Quantities are numeric(14,3) strings in the variant's base unit. */
export const stockLedger = pgTable("stock_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  variantId: uuid("variant_id").notNull(),
  locationId: uuid("location_id").notNull(),
  qtyBase: numeric("qty_base", { precision: 14, scale: 3 }).notNull(),
  unitCostPaisa: bigint("unit_cost_paisa", { mode: "number" }).notNull().default(0),
  docType: text("doc_type").notNull(),
  docId: uuid("doc_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  /** Posting order; created_at ties within a transaction. See migration 0003. */
  seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
}, (table) => [
  index("stock_ledger_variant_idx").on(table.businessId, table.variantId, table.locationId, table.createdAt),
]);

/** Written only by the stock_ledger trigger; read it, never insert or update it. */
export const stockBalances = pgTable("stock_balances", {
  businessId: businessId(),
  variantId: uuid("variant_id").notNull(),
  locationId: uuid("location_id").notNull(),
  onHand: numeric("on_hand", { precision: 14, scale: 3 }).notNull().default("0"),
  reserved: numeric("reserved", { precision: 14, scale: 3 }).notNull().default("0"),
  avgCostPaisa: bigint("avg_cost_paisa", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.variantId, table.locationId] }),
]);

export const stockAdjustments = pgTable("stock_adjustments", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  locationId: uuid("location_id").notNull(),
  reason: text("reason", { enum: ["damage", "theft", "expiry", "found", "correction", "opening"] }).notNull(),
  note: text("note").notNull().default(""),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  totalValuePaisa: bigint("total_value_paisa", { mode: "number" }).notNull().default(0),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

export const stockAdjustmentLines = pgTable("stock_adjustment_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  adjustmentId: uuid("adjustment_id").notNull(),
  variantId: uuid("variant_id").notNull(),
  unitId: uuid("unit_id").notNull(),
  qtyEntered: numeric("qty_entered", { precision: 14, scale: 3 }).notNull(),
  qtyBaseDelta: numeric("qty_base_delta", { precision: 14, scale: 3 }).notNull(),
  unitCostPaisa: bigint("unit_cost_paisa", { mode: "number" }).notNull().default(0),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  businessId: businessId(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  statusCode: integer("status_code"),
  response: jsonb("response").$type<unknown>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.businessId, table.key] }),
]);
