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
  /** What the customer owes (positive) or is owed (negative, store credit). Written only by the party_ledger trigger. */
  balancePaisa: bigint("balance_paisa", { mode: "number" }).notNull().default(0),
  ...audited,
});

// Tables from migration 0007. The posting functions write them; the API reads them.
export const partyLedger = pgTable("party_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  businessId: businessId(),
  partyType: text("party_type").notNull(),
  partyId: uuid("party_id").notNull(),
  docType: text("doc_type").notNull(),
  docId: uuid("doc_id").notNull(),
  docNumber: text("doc_number").notNull().default(""),
  memo: text("memo").notNull().default(""),
  debitPaisa: bigint("debit_paisa", { mode: "number" }).notNull().default(0),
  creditPaisa: bigint("credit_paisa", { mode: "number" }).notNull().default(0),
  entryAt: timestamp("entry_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export const customerPayments = pgTable("customer_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  branchId: uuid("branch_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  number: text("number").notNull(),
  sequenceNo: integer("sequence_no").notNull(),
  shiftId: uuid("shift_id"),
  methodId: uuid("method_id").notNull(),
  methodCode: text("method_code").notNull(),
  methodName: text("method_name").notNull(),
  tenderKind: text("tender_kind").notNull(),
  amountPaisa: bigint("amount_paisa", { mode: "number" }).notNull(),
  reference: text("reference").notNull().default(""),
  note: text("note").notNull().default(""),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export const paymentAllocations = pgTable("payment_allocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: businessId(),
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id").notNull(),
  invoiceId: uuid("invoice_id").notNull(),
  amountPaisa: bigint("amount_paisa", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
