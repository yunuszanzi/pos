import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const businesses = pgTable("businesses", {
  id: uuid("id").defaultRandom().primaryKey(),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name").notNull(),
  logoUrl: text("logo_url"),
  address: text("address").notNull().default(""),
  phone: text("phone").notNull().default(""),
  ntn: text("ntn"),
  strn: text("strn"),
  province: text("province").notNull().default(""),
  receiptFooter: text("receipt_footer").notNull().default(""),
  settings: jsonb("settings").$type<Record<string, string | number | boolean>>().notNull().default({}),
  ...timestamps,
});

export const branches = pgTable("branches", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code").notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("branches_business_code_uidx").on(table.businessId, table.code),
  index("branches_business_id_idx").on(table.businessId),
]);

export const locations = pgTable("locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["store", "warehouse", "damaged"] }).notNull().default("store"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  index("locations_business_branch_idx").on(table.businessId, table.branchId),
]);

export const terminals = pgTable("terminals", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  defaultPrintFormat: text("default_print_format", { enum: ["pos80", "pos58", "a4", "a5"] }).notNull().default("pos80"),
  fbrPosId: text("fbr_pos_id"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  index("terminals_business_branch_idx").on(table.businessId, table.branchId),
]);

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isSystem: boolean("is_system").notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("roles_business_name_uidx").on(table.businessId, table.name),
]);

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable("role_permissions", {
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permissionKey: text("permission_key").notNull().references(() => permissions.key, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.roleId, table.permissionKey] }),
]);

export const appUsers = pgTable("users", {
  id: uuid("id").primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  pinHash: text("pin_hash"),
  active: boolean("active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("users_business_email_uidx").on(table.businessId, table.email),
  index("users_business_role_idx").on(table.businessId, table.roleId),
]);

export const authSessions = pgTable("auth_sessions", {
  sessionId: uuid("session_id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => appUsers.id, { onDelete: "cascade" }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pinAttempts = pgTable("pin_attempts", {
  rateKey: text("rate_key").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userBranches = pgTable("user_branches", {
  userId: uuid("user_id").notNull().references(() => appUsers.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.userId, table.branchId] }),
]);

export const documentSeries = pgTable("document_series", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  docType: text("doc_type").notNull(),
  prefix: text("prefix").notNull(),
  nextNumber: integer("next_number").notNull().default(1),
  ...timestamps,
}, (table) => [
  uniqueIndex("document_series_scope_uidx").on(table.businessId, table.branchId, table.docType),
]);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown> | null>(),
  userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
  terminalId: uuid("terminal_id").references(() => terminals.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_business_created_idx").on(table.businessId, table.createdAt),
  index("audit_entity_idx").on(table.businessId, table.entity, table.entityId),
]);

export const businessSettings = pgTable("business_settings", {
  businessId: uuid("business_id").primaryKey().references(() => businesses.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("PKR"),
  timezone: text("timezone").notNull().default("Asia/Karachi"),
  dateFormat: text("date_format").notNull().default("dd/MM/yyyy"),
  amountRounding: integer("amount_rounding").notNull().default(2),
  sessionTimeoutMinutes: integer("session_timeout_minutes").notNull().default(30),
  posSessionTimeoutHours: integer("pos_session_timeout_hours").notNull().default(12),
  ...timestamps,
});
