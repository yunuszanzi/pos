// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasLocalStack, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

integration("Foundation database migrations", () => {
  it("creates the Foundation tables", async () => {
    const client = sql();
    try {
      const tables = await client<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `;
      expect(tables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
        "businesses", "branches", "locations", "terminals", "users", "roles", "permissions", "role_permissions",
        "user_branches", "document_series", "business_settings", "auth_sessions", "pin_attempts", "audit_log",
      ]));
    } finally {
      await client.end();
    }
  });

  it("keeps the audit log append-only for UPDATE and DELETE", async () => {
    const client = sql();
    try {
      const events = await client<{ event_manipulation: string }[]>`
        SELECT event_manipulation FROM information_schema.triggers
        WHERE event_object_table = 'audit_log' AND trigger_name = 'audit_log_immutable'
      `;
      expect(events.map((row) => row.event_manipulation).sort()).toEqual(["DELETE", "UPDATE"]);
      const [business] = await client<{ id: string }[]>`
        INSERT INTO businesses (legal_name, trade_name) VALUES ('Audit Test', 'Audit Test') RETURNING id
      `;
      const [entry] = await client<{ id: string }[]>`
        INSERT INTO audit_log (business_id, entity, entity_id, action)
        VALUES (${business.id}, 'business', ${business.id}, 'test') RETURNING id
      `;
      await expect(client`UPDATE audit_log SET action = 'tampered' WHERE id = ${entry.id}`).rejects.toThrow(/append-only/);
      await expect(client`DELETE FROM audit_log WHERE id = ${entry.id}`).rejects.toThrow(/append-only/);
    } finally {
      await client.end();
    }
  });
});
