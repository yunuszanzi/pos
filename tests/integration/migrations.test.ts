import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("Foundation database migrations", () => {
  it("creates the Foundation tables and keeps the audit log append-only", async () => {
    const client = postgres(databaseUrl!, { prepare: false, max: 1 });
    try {
      const tables = await client<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('businesses', 'branches', 'locations', 'terminals', 'users', 'roles', 'permissions', 'document_series', 'business_settings', 'auth_sessions', 'audit_log')
      `;
      expect(tables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
        "businesses", "branches", "locations", "terminals", "users", "roles", "permissions",
        "document_series", "business_settings", "auth_sessions", "audit_log",
      ]));
      const triggers = await client<{ trigger_name: string }[]>`
        SELECT trigger_name FROM information_schema.triggers
        WHERE event_object_table = 'audit_log' AND trigger_name = 'audit_log_immutable'
      `;
      expect(triggers).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});
