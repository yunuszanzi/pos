// @vitest-environment node
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { cashierPermissionKeys, managerPermissionKeys, allPermissionKeys } from "../../shared/permissions";
import { hasLocalStack } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

const migrationsDirectory = join(process.cwd(), "db", "migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();

/** Same SQL the migration runner applies, one transaction per file, against a throwaway database. */
async function withScratchDatabase<T>(work: (sql: postgres.Sql, apply: (files: string[]) => Promise<void>) => Promise<T>): Promise<T> {
  const adminUrl = new URL(process.env.DATABASE_URL!);
  const name = `pos_migration_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl.toString(), { prepare: false, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${name}`;
  const sql = postgres(scratchUrl.toString(), { prepare: false, max: 1, onnotice: () => undefined });
  try {
    // Supabase provides the auth schema; the migrations only need its users table and uid().
    await sql.unsafe(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
    const apply = async (files: string[]) => {
      for (const file of files) {
        await sql.begin((transaction) => transaction.unsafe(readFileSync(join(migrationsDirectory, file), "utf8")));
      }
    };
    return await work(sql, apply);
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

const columnsOf = (sql: postgres.Sql) => sql<{ table_name: string; column_name: string; data_type: string; is_nullable: string }[]>`
  SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
  WHERE table_schema = 'public' ORDER BY table_name, column_name
`;

integration("database migrations", { timeout: 120_000 }, () => {
  it("applies cleanly to an empty database", async () => {
    await withScratchDatabase(async (sql, apply) => {
      await apply(migrationFiles);
      const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
      expect(tables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
        "businesses", "users", "audit_log", "products", "product_variants", "stock_ledger", "stock_balances", "stock_adjustments", "idempotency_keys",
      ]));
      const [{ count }] = await sql<{ count: string }[]>`SELECT count(*) FROM permissions`;
      expect(Number(count)).toBe(allPermissionKeys.length);
    });
  });

  it("upgrades a database that already has v0.1 businesses, backfilling defaults and permissions", async () => {
    await withScratchDatabase(async (sql, apply) => {
      const lastV01 = migrationFiles.findIndex((name) => name.startsWith("0001"));
      await apply(migrationFiles.slice(0, lastV01 + 1));

      // A business as v0.1 left it: system roles, an owner, settings, and no catalogue tables yet.
      const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id`;
      const [business] = await sql<{ id: string }[]>`INSERT INTO businesses (legal_name, trade_name) VALUES ('Legacy Traders', 'Legacy') RETURNING id`;
      const roleIds: Record<string, string> = {};
      for (const name of ["Owner", "Manager", "Cashier"]) {
        const [role] = await sql<{ id: string }[]>`INSERT INTO roles (business_id, name, is_system) VALUES (${business.id}, ${name}, true) RETURNING id`;
        roleIds[name] = role.id;
      }
      await sql`INSERT INTO users (id, business_id, role_id, email, display_name) VALUES (${owner.id}, ${business.id}, ${roleIds.Owner}, 'owner@legacy.test', 'Owner')`;
      await sql`INSERT INTO business_settings (business_id) VALUES (${business.id})`;
      await sql`INSERT INTO role_permissions (role_id, permission_key) VALUES (${roleIds.Cashier}, 'branches.view'), (${roleIds.Cashier}, 'auth.pin_switch')`;
      const [custom] = await sql<{ id: string }[]>`INSERT INTO roles (business_id, name, is_system) VALUES (${business.id}, 'Custom', false) RETURNING id`;
      await sql`INSERT INTO role_permissions (role_id, permission_key) VALUES (${custom.id}, 'branches.view')`;

      await apply(migrationFiles.slice(lastV01 + 1));

      const taxes = await sql<{ name: string; rate_bps: number; created_by: string }[]>`SELECT name, rate_bps, created_by FROM tax_categories WHERE business_id = ${business.id} ORDER BY name`;
      expect(taxes).toHaveLength(5);
      expect(taxes.find((tax) => tax.name === "Standard rate 18%")?.rate_bps).toBe(1800);
      expect(taxes.every((tax) => tax.created_by === owner.id)).toBe(true);
      expect((await sql`SELECT 1 FROM units WHERE business_id = ${business.id}`)).toHaveLength(8);

      const granted = async (roleId: string) => (await sql<{ permission_key: string }[]>`SELECT permission_key FROM role_permissions WHERE role_id = ${roleId}`).map((row) => row.permission_key);
      const catalogueKeys = managerPermissionKeys.filter((key) => /^(catalog|products|inventory)\./.test(key));
      expect(await granted(roleIds.Owner)).toEqual(expect.arrayContaining(catalogueKeys));
      expect(await granted(roleIds.Manager)).toEqual(expect.arrayContaining(catalogueKeys));
      expect((await granted(roleIds.Cashier)).sort()).toEqual(["auth.pin_switch", "branches.view", ...cashierPermissionKeys.filter((key) => /^(catalog|inventory)\./.test(key))].sort());
      expect(await granted(custom.id)).toEqual(["branches.view"]);

      const [settings] = await sql<{ adjustment_approval_threshold_paisa: string }[]>`SELECT adjustment_approval_threshold_paisa FROM business_settings WHERE business_id = ${business.id}`;
      expect(Number(settings.adjustment_approval_threshold_paisa)).toBe(1_000_000);

      // The stock machinery works on the upgraded database.
      const [location] = await sql<{ id: string }[]>`
        WITH branch AS (INSERT INTO branches (business_id, name, code) VALUES (${business.id}, 'Main', 'MN') RETURNING id)
        INSERT INTO locations (business_id, branch_id, name) SELECT ${business.id}, id, 'Store' FROM branch RETURNING id`;
      const [unit] = await sql<{ id: string }[]>`SELECT id FROM units WHERE business_id = ${business.id} AND name = 'Piece'`;
      const [product] = await sql<{ id: string }[]>`INSERT INTO products (business_id, name, base_unit_id) VALUES (${business.id}, 'Item', ${unit.id}) RETURNING id`;
      const [variant] = await sql<{ id: string }[]>`INSERT INTO product_variants (business_id, product_id, sku) VALUES (${business.id}, ${product.id}, 'LEG-1') RETURNING id`;
      const [adjustment] = await sql<{ id: string }[]>`INSERT INTO stock_adjustments (business_id, location_id, reason) VALUES (${business.id}, ${location.id}, 'found') RETURNING id`;
      await sql`INSERT INTO stock_adjustment_lines (business_id, adjustment_id, variant_id, unit_id, qty_entered, qty_base_delta, unit_cost_paisa) VALUES (${business.id}, ${adjustment.id}, ${variant.id}, ${unit.id}, 9, 9, 250)`;
      await sql`SELECT post_stock_adjustment(${adjustment.id}, ${owner.id})`;
      const [balance] = await sql<{ on_hand: string; avg_cost_paisa: string }[]>`SELECT on_hand, avg_cost_paisa FROM stock_balances WHERE variant_id = ${variant.id}`;
      expect(Number(balance.on_hand)).toBe(9);
      expect(Number(balance.avg_cost_paisa)).toBe(250);
      const [entry] = await sql<{ seq: string }[]>`SELECT seq FROM stock_ledger WHERE variant_id = ${variant.id}`;
      expect(Number(entry.seq)).toBeGreaterThan(0);
    });
  });

  it("gives an upgraded database exactly the same structure as a fresh one", async () => {
    const fresh = await withScratchDatabase(async (sql, apply) => {
      await apply(migrationFiles);
      return columnsOf(sql).then((rows) => rows.map((row) => `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}`));
    });
    const upgraded = await withScratchDatabase(async (sql, apply) => {
      await apply(migrationFiles.slice(0, 2));
      await apply(migrationFiles.slice(2));
      return columnsOf(sql).then((rows) => rows.map((row) => `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}`));
    });
    expect(upgraded).toEqual(fresh);
    expect(fresh.length).toBeGreaterThan(150);
  });
});
