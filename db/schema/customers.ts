import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./system";

// Tables from migration 0006. created_by / updated_by reference auth.users; Drizzle only needs the columns.
const audited = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
};
const businessId = () => uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" });

export const areas = pgTable("areas", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  ...audited,
});

export const customerGroups = pgTable("customer_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  priceListId: uuid("price_list_id"),
  active: boolean("active").notNull().default(true),
  ...audited,
});

export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  name: text("name").notNull(),
  businessName: text("business_name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  phone2: text("phone2").notNull().default(""),
  whatsapp: text("whatsapp").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  areaId: uuid("area_id"),
  groupId: uuid("group_id"),
  cnic: text("cnic"),
  ntn: text("ntn"),
  strn: text("strn"),
  registered: boolean("registered").notNull().default(false),
  priceListId: uuid("price_list_id"),
  creditLimitPaisa: bigint("credit_limit_paisa", { mode: "number" }).notNull().default(0),
  termsDays: integer("terms_days").notNull().default(0),
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  /** Set by a trigger to the dataset version this row last changed at. */
  changeVersion: bigint("change_version", { mode: "number" }).notNull().default(0),
  ...audited,
});
