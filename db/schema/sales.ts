import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./system";

// Tables from migration 0005. created_by / updated_by reference auth.users; Drizzle only needs the columns.
const businessId = () => uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" });

export const paymentMethods = pgTable("payment_methods", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["cash", "card", "bank", "wallet"] }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  fbrPaymentCode: text("fbr_payment_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

export const shifts = pgTable("shifts", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  branchId: uuid("branch_id").notNull(),
  terminalId: uuid("terminal_id").notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  openedBy: uuid("opened_by").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  openingFloatPaisa: bigint("opening_float_paisa", { mode: "number" }).notNull(),
  closedBy: uuid("closed_by"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  countedPaisa: bigint("counted_paisa", { mode: "number" }),
  countedBreakdown: jsonb("counted_breakdown").$type<Record<string, number>>(),
  expectedPaisa: bigint("expected_paisa", { mode: "number" }),
  variancePaisa: bigint("variance_paisa", { mode: "number" }),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

export const cashMovements = pgTable("cash_movements", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  shiftId: uuid("shift_id").notNull(),
  kind: text("kind", { enum: ["cash_in", "cash_out"] }).notNull(),
  amountPaisa: bigint("amount_paisa", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export const salesInvoices = pgTable("sales_invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  branchId: uuid("branch_id").notNull(),
  terminalId: uuid("terminal_id").notNull(),
  shiftId: uuid("shift_id").notNull(),
  locationId: uuid("location_id").notNull(),
  number: text("number").notNull(),
  sequenceNo: integer("sequence_no").notNull(),
  customerId: uuid("customer_id"),
  cashierId: uuid("cashier_id").notNull(),
  taxMode: text("tax_mode", { enum: ["inclusive", "exclusive"] }).notNull(),
  grossPaisa: bigint("gross_paisa", { mode: "number" }).notNull(),
  lineDiscountPaisa: bigint("line_discount_paisa", { mode: "number" }).notNull(),
  invoiceDiscountPaisa: bigint("invoice_discount_paisa", { mode: "number" }).notNull(),
  taxablePaisa: bigint("taxable_paisa", { mode: "number" }).notNull(),
  taxPaisa: bigint("tax_paisa", { mode: "number" }).notNull(),
  roundingPaisa: bigint("rounding_paisa", { mode: "number" }).notNull(),
  totalPaisa: bigint("total_paisa", { mode: "number" }).notNull(),
  paidPaisa: bigint("paid_paisa", { mode: "number" }).notNull(),
  changePaisa: bigint("change_paisa", { mode: "number" }).notNull(),
  balancePaisa: bigint("balance_paisa", { mode: "number" }).notNull(),
  approvedBy: uuid("approved_by"),
  approvalNote: text("approval_note"),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
}, (table) => [
  index("sales_invoices_posted_idx").on(table.businessId, table.postedAt),
]);

export const salesInvoiceLines = pgTable("sales_invoice_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  invoiceId: uuid("invoice_id").notNull(),
  lineNo: integer("line_no").notNull(),
  variantId: uuid("variant_id").notNull(),
  unitId: uuid("unit_id").notNull(),
  productName: text("product_name").notNull(),
  variantName: text("variant_name").notNull().default(""),
  sku: text("sku").notNull(),
  unitName: text("unit_name").notNull(),
  hsCode: text("hs_code"),
  qtyEntered: numeric("qty_entered", { precision: 14, scale: 3 }).notNull(),
  factorToBase: numeric("factor_to_base", { precision: 14, scale: 3 }).notNull(),
  qtyBase: numeric("qty_base", { precision: 14, scale: 3 }).notNull(),
  unitPricePaisa: bigint("unit_price_paisa", { mode: "number" }).notNull(),
  grossPaisa: bigint("gross_paisa", { mode: "number" }).notNull(),
  lineDiscountPaisa: bigint("line_discount_paisa", { mode: "number" }).notNull(),
  invoiceDiscountSharePaisa: bigint("invoice_discount_share_paisa", { mode: "number" }).notNull(),
  netPaisa: bigint("net_paisa", { mode: "number" }).notNull(),
  taxRateBps: integer("tax_rate_bps").notNull(),
  taxIncluded: boolean("tax_included").notNull(),
  taxablePaisa: bigint("taxable_paisa", { mode: "number" }).notNull(),
  taxPaisa: bigint("tax_paisa", { mode: "number" }).notNull(),
  totalPaisa: bigint("total_paisa", { mode: "number" }).notNull(),
  costPaisa: bigint("cost_paisa", { mode: "number" }).notNull(),
  returnedQtyBase: numeric("returned_qty_base", { precision: 14, scale: 3 }).notNull().default("0"),
});

export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  invoiceId: uuid("invoice_id").notNull(),
  methodId: uuid("method_id").notNull(),
  methodCode: text("method_code").notNull(),
  methodName: text("method_name").notNull(),
  tenderKind: text("tender_kind", { enum: ["cash", "other"] }).notNull(),
  amountPaisa: bigint("amount_paisa", { mode: "number" }).notNull(),
  tenderedPaisa: bigint("tendered_paisa", { mode: "number" }).notNull(),
  changePaisa: bigint("change_paisa", { mode: "number" }).notNull(),
  reference: text("reference").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export const heldSales = pgTable("held_sales", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  terminalId: uuid("terminal_id").notNull(),
  heldBy: uuid("held_by").notNull(),
  name: text("name").notNull().default(""),
  cart: jsonb("cart").$type<unknown>().notNull(),
  totalPaisa: bigint("total_paisa", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dataVersions = pgTable("data_versions", {
  businessId: businessId(),
  dataset: text("dataset").notNull(),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.businessId, table.dataset] }),
]);
