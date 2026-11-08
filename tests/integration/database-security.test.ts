// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createTestBusiness, hasLocalStack, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

const foundationTables = [
  "businesses", "branches", "locations", "terminals", "roles", "permissions", "role_permissions", "users",
  "user_branches", "auth_sessions", "pin_attempts", "document_series", "business_settings", "audit_log",
  "idempotency_keys", "categories", "brands", "tax_categories", "units", "products", "product_variants", "product_units",
  "price_lists", "price_list_items", "stock_ledger", "stock_balances", "stock_adjustments", "stock_adjustment_lines",
  "payment_methods", "shifts", "cash_movements", "sales_invoices", "sales_invoice_lines", "payments", "held_sales", "data_versions",
  "areas", "customer_groups", "customers", "party_ledger", "customer_payments", "payment_allocations", "sales_returns", "sales_return_lines", "cheques", "suppliers", "purchase_orders", "purchase_order_lines", "goods_receipts", "goods_receipt_lines", "purchase_bills", "purchase_bill_lines", "purchase_bill_charges",
];

function supabaseAs(accessToken: string) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

integration("database access outside the API (technical-plan 3.3)", { timeout: 60_000 }, () => {
  it("gives a signed-in browser no direct read or write access to business tables", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const browser = supabaseAs(cashier.token);
    for (const table of foundationTables) {
      const read = await browser.from(table).select("*").limit(1);
      expect(read.error?.code, `select ${table}`).toBe("42501");
    }
    const write = await browser.from("audit_log").insert({ business_id: business.businessId, entity: "x", entity_id: "x", action: "forged" });
    expect(write.error?.code).toBe("42501");
  });

  it("records who created and last updated each record", async () => {
    const business = await createTestBusiness();
    const manager = await inviteTestStaff(business, "Manager");
    const client = sql();
    try {
      const [created] = await client<{ created_by: string; updated_by: string }[]>`
        SELECT created_by, updated_by FROM branches WHERE id = ${business.branchId}
      `;
      expect(created).toEqual({ created_by: business.ownerId, updated_by: business.ownerId });

      const { callApi } = await import("./helpers");
      expect((await callApi(manager.token, "PUT", `/branches/${business.branchId}`, { body: { name: "Saddar" } })).status).toBe(200);
      const [updated] = await client<{ created_by: string; updated_by: string }[]>`
        SELECT created_by, updated_by FROM branches WHERE id = ${business.branchId}
      `;
      expect(updated).toEqual({ created_by: business.ownerId, updated_by: manager.id });

      for (const table of ["businesses", "branches", "locations", "terminals", "roles", "users", "document_series", "business_settings", "tax_categories", "units"]) {
        const [row] = await client<{ missing: number }[]>`
          SELECT count(*)::int AS missing FROM ${client(table)}
          WHERE created_by IS NULL AND ${client(table === "businesses" ? "id" : "business_id")} = ${business.businessId}
        `;
        expect(row.missing, `${table}.created_by`).toBe(0);
      }
    } finally {
      await client.end();
    }
  });
});
