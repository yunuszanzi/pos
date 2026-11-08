import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./system";

// Tables from migration 0011. created_by / updated_by reference auth.users; Drizzle only needs the columns.
export const suppliers = pgTable("suppliers", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactPerson: text("contact_person").notNull().default(""),
  phone: text("phone").notNull().default(""),
  whatsapp: text("whatsapp").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  ntn: text("ntn"),
  strn: text("strn"),
  registered: boolean("registered").notNull().default(false),
  termsDays: integer("terms_days").notNull().default(0),
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  /** What the shop owes the supplier (positive), or what they owe the shop (negative). Written only by the party_ledger trigger. */
  balancePaisa: bigint("balance_paisa", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});
