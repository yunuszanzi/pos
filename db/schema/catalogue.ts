import { bigint, boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./system";

// created_by / updated_by reference auth.users (see migration 0002); Drizzle only needs the columns.
const audited = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
};

const businessId = () => uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" });

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  ...audited,
});

export const brands = pgTable("brands", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  ...audited,
});

export const taxCategories = pgTable("tax_categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["standard", "reduced", "zero_rated", "exempt", "third_schedule"] }).notNull(),
  rateBps: integer("rate_bps").notNull(),
  fbrSaleType: text("fbr_sale_type"),
  active: boolean("active").notNull().default(true),
  ...audited,
});

export const units = pgTable("units", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  active: boolean("active").notNull().default(true),
  ...audited,
});

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  categoryId: uuid("category_id"),
  brandId: uuid("brand_id"),
  taxCategoryId: uuid("tax_category_id"),
  hsCode: text("hs_code"),
  imageUrl: text("image_url"),
  productType: text("product_type", { enum: ["stocked", "non_stock", "service"] }).notNull().default("stocked"),
  baseUnitId: uuid("base_unit_id").notNull(),
  active: boolean("active").notNull().default(true),
  /** Set by a trigger to the dataset version this product (or its SKUs or units) last changed at. */
  catalogVersion: bigint("catalog_version", { mode: "number" }).notNull().default(0),
  ...audited,
}, (table) => [
  index("products_category_idx").on(table.businessId, table.categoryId),
]);

export const productVariants = pgTable("product_variants", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  productId: uuid("product_id").notNull(),
  sku: text("sku").notNull(),
  variantName: text("variant_name").notNull().default(""),
  attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
  costPaisa: bigint("cost_paisa", { mode: "number" }).notNull().default(0),
  reorderLevel: numeric("reorder_level", { precision: 14, scale: 3 }).notNull().default("0"),
  reorderQuantity: numeric("reorder_quantity", { precision: 14, scale: 3 }).notNull().default("0"),
  active: boolean("active").notNull().default(true),
  ...audited,
}, (table) => [
  index("product_variants_product_idx").on(table.businessId, table.productId),
]);

export const productUnits = pgTable("product_units", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  variantId: uuid("variant_id").notNull(),
  unitId: uuid("unit_id").notNull(),
  factorToBase: numeric("factor_to_base", { precision: 14, scale: 3 }).notNull(),
  isBase: boolean("is_base").notNull().default(false),
  barcode: text("barcode"),
  salePricePaisa: bigint("sale_price_paisa", { mode: "number" }).notNull().default(0),
  fbrUom: text("fbr_uom"),
  ...audited,
}, (table) => [
  uniqueIndex("product_units_variant_unit_uidx").on(table.variantId, table.unitId),
]);

export const priceLists = pgTable("price_lists", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  ...audited,
});

export const priceListItems = pgTable("price_list_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  priceListId: uuid("price_list_id").notNull(),
  variantId: uuid("variant_id").notNull(),
  unitId: uuid("unit_id").notNull(),
  minQuantity: numeric("min_quantity", { precision: 14, scale: 3 }).notNull().default("1"),
  pricePaisa: bigint("price_paisa", { mode: "number" }).notNull(),
  ...audited,
});
