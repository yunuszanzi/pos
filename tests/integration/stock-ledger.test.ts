// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cashierPermissionKeys, managerPermissionKeys, allPermissionKeys } from "../../shared/permissions";
import { toBaseQuantity, parseQuantity, formatQuantity } from "../../shared/units";
import { callApi, createTestBusiness, hasLocalStack, sql, type TestBusiness } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

type Db = ReturnType<typeof sql>;

async function locationOf(business: TestBusiness): Promise<string> {
  const locations = await callApi<Array<{ id: string }>>(business.ownerToken, "GET", "/locations");
  return locations.body[0].id;
}

async function createVariant(client: Db, business: TestBusiness, sku: string, costPaisa = 0) {
  const [unit] = await client<{ id: string }[]>`SELECT id FROM units WHERE business_id = ${business.businessId} AND name = 'Piece'`;
  const [product] = await client<{ id: string }[]>`
    INSERT INTO products (business_id, name, base_unit_id) VALUES (${business.businessId}, ${sku}, ${unit.id}) RETURNING id
  `;
  const [variant] = await client<{ id: string }[]>`
    INSERT INTO product_variants (business_id, product_id, sku, cost_paisa)
    VALUES (${business.businessId}, ${product.id}, ${sku}, ${costPaisa}) RETURNING id
  `;
  return { variantId: variant.id, productId: product.id, unitId: unit.id };
}

async function postAdjustment(
  client: Db,
  business: TestBusiness,
  locationId: string,
  lines: Array<{ variantId: string; unitId: string; delta: string; costPaisa?: number }>,
  reason = "found",
) {
  const [adjustment] = await client<{ id: string }[]>`
    INSERT INTO stock_adjustments (business_id, location_id, reason, created_by)
    VALUES (${business.businessId}, ${locationId}, ${reason}, ${business.ownerId}) RETURNING id
  `;
  for (const line of lines) {
    await client`
      INSERT INTO stock_adjustment_lines (business_id, adjustment_id, variant_id, unit_id, qty_entered, qty_base_delta, unit_cost_paisa)
      VALUES (${business.businessId}, ${adjustment.id}, ${line.variantId}, ${line.unitId}, ${line.delta}, ${line.delta}, ${line.costPaisa ?? 0})
    `;
  }
  return adjustment.id;
}

async function balance(client: Db, variantId: string, locationId: string) {
  const [row] = await client<{ on_hand: string; avg_cost_paisa: string }[]>`
    SELECT on_hand, avg_cost_paisa FROM stock_balances WHERE variant_id = ${variantId} AND location_id = ${locationId}
  `;
  return row;
}

integration("v0.2 catalogue and stock database layer", { timeout: 90_000 }, () => {
  it("seeds tax categories and units for a new business and grants the new permissions to system roles", async () => {
    const business = await createTestBusiness();
    const client = sql();
    try {
      const taxes = await client<{ kind: string; rate_bps: number }[]>`
        SELECT kind, rate_bps FROM tax_categories WHERE business_id = ${business.businessId} ORDER BY kind
      `;
      expect(taxes.map((tax) => tax.kind)).toEqual(["exempt", "reduced", "standard", "third_schedule", "zero_rated"]);
      expect(taxes.find((tax) => tax.kind === "standard")?.rate_bps).toBe(1800);
      const units = await client<{ name: string }[]>`SELECT name FROM units WHERE business_id = ${business.businessId}`;
      expect(units.map((unit) => unit.name)).toEqual(expect.arrayContaining(["Piece", "Pack", "Carton"]));

      const keysOf = async (roleId: string) => (await client<{ permission_key: string }[]>`
        SELECT permission_key FROM role_permissions WHERE role_id = ${roleId}
      `).map((row) => row.permission_key).sort();
      expect(await keysOf(business.roleIds.Manager)).toEqual([...managerPermissionKeys].sort());
      expect(await keysOf(business.roleIds.Cashier)).toEqual([...cashierPermissionKeys].sort());
      expect(await keysOf(business.roleIds.Owner)).toEqual([...allPermissionKeys].sort());
      expect(cashierPermissionKeys).not.toContain("products.cost.view");
    } finally {
      await client.end();
    }
  });

  it("defaults the adjustment approval threshold to PKR 10,000 and lets the owner change it", async () => {
    const business = await createTestBusiness();
    const settings = await callApi(business.ownerToken, "GET", "/settings");
    expect(settings.body.adjustmentApprovalThresholdPaisa).toBe(1_000_000);
    const updated = await callApi(business.ownerToken, "PUT", "/settings", {
      body: { ...settings.body, adjustmentApprovalThresholdPaisa: 2_500_000 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.adjustmentApprovalThresholdPaisa).toBe(2_500_000);
  });

  it("keeps balances equal to the ledger and refuses to change the ledger", async () => {
    const business = await createTestBusiness();
    const locationId = await locationOf(business);
    const client = sql();
    try {
      const { variantId, unitId } = await createVariant(client, business, "BAL-10");
      const first = await postAdjustment(client, business, locationId, [{ variantId, unitId, delta: "100", costPaisa: 5000 }]);
      await client`SELECT post_stock_adjustment(${first}, ${business.ownerId})`;
      const second = await postAdjustment(client, business, locationId, [{ variantId, unitId, delta: "-30.5" }], "damage");
      await client`SELECT post_stock_adjustment(${second}, ${business.ownerId})`;

      expect((await balance(client, variantId, locationId)).on_hand).toBe("69.500");
      const [sum] = await client<{ total: string }[]>`SELECT sum(qty_base) AS total FROM stock_ledger WHERE variant_id = ${variantId}`;
      expect(sum.total).toBe("69.500");

      await expect(client`UPDATE stock_ledger SET qty_base = 1 WHERE variant_id = ${variantId}`).rejects.toThrow(/append-only/);
      await expect(client`DELETE FROM stock_ledger WHERE variant_id = ${variantId}`).rejects.toThrow(/append-only/);
    } finally {
      await client.end();
    }
  });

  it("recalculates weighted average cost on receipts and keeps it on issues", async () => {
    const business = await createTestBusiness();
    const locationId = await locationOf(business);
    const client = sql();
    try {
      const { variantId, unitId } = await createVariant(client, business, "AVG-10");
      const receive = async (qty: string, cost: number) => {
        const id = await postAdjustment(client, business, locationId, [{ variantId, unitId, delta: qty, costPaisa: cost }]);
        await client`SELECT post_stock_adjustment(${id}, ${business.ownerId})`;
      };
      await receive("100", 1000);
      expect((await balance(client, variantId, locationId)).avg_cost_paisa).toBe("1000");
      await receive("50", 1600);
      // (100 x 1000 + 50 x 1600) / 150 = 1200
      expect((await balance(client, variantId, locationId)).avg_cost_paisa).toBe("1200");

      const issue = await postAdjustment(client, business, locationId, [{ variantId, unitId, delta: "-20" }], "damage");
      await client`SELECT post_stock_adjustment(${issue}, ${business.ownerId})`;
      const after = await balance(client, variantId, locationId);
      expect(after.avg_cost_paisa).toBe("1200");
      expect(after.on_hand).toBe("130.000");
      const [entry] = await client<{ unit_cost_paisa: string }[]>`
        SELECT unit_cost_paisa FROM stock_ledger WHERE doc_id = ${issue}
      `;
      expect(entry.unit_cost_paisa).toBe("1200");
    } finally {
      await client.end();
    }
  });

  it("posts an adjustment once, refuses negative stock, and freezes decided adjustments", async () => {
    const business = await createTestBusiness();
    const locationId = await locationOf(business);
    const client = sql();
    try {
      const { variantId, unitId } = await createVariant(client, business, "ADJ-10");
      const tooMuch = await postAdjustment(client, business, locationId, [{ variantId, unitId, delta: "-1" }], "theft");
      await expect(client`SELECT post_stock_adjustment(${tooMuch}, ${business.ownerId})`).rejects.toThrow(/STOCK_INSUFFICIENT/);
      const [still] = await client<{ status: string }[]>`SELECT status FROM stock_adjustments WHERE id = ${tooMuch}`;
      expect(still.status).toBe("pending");
      expect(await client`SELECT 1 FROM stock_ledger WHERE doc_id = ${tooMuch}`).toHaveLength(0);

      const opening = await postAdjustment(client, business, locationId, [{ variantId, unitId, delta: "10", costPaisa: 100 }], "opening");
      await client`SELECT post_stock_adjustment(${opening}, ${business.ownerId})`;
      await expect(client`SELECT post_stock_adjustment(${opening}, ${business.ownerId})`).rejects.toThrow(/ADJUSTMENT_NOT_PENDING/);
      expect((await balance(client, variantId, locationId)).on_hand).toBe("10.000");

      const [decided] = await client<{ status: string; approved_by: string }[]>`
        SELECT status, approved_by FROM stock_adjustments WHERE id = ${opening}
      `;
      expect(decided).toEqual({ status: "approved", approved_by: business.ownerId });
      await expect(client`UPDATE stock_adjustments SET note = 'edited' WHERE id = ${opening}`).rejects.toThrow(/cannot be changed/);
      await expect(client`DELETE FROM stock_adjustments WHERE id = ${opening}`).rejects.toThrow(/cannot be changed or deleted/);
      await expect(client`UPDATE stock_adjustment_lines SET qty_base_delta = 99 WHERE adjustment_id = ${opening}`).rejects.toThrow(/decided/);
      await expect(client`
        INSERT INTO stock_adjustment_lines (business_id, adjustment_id, variant_id, unit_id, qty_entered, qty_base_delta)
        VALUES (${business.businessId}, ${opening}, ${variantId}, ${unitId}, 1, 1)
      `).rejects.toThrow(/decided/);
    } finally {
      await client.end();
    }
  });

  it("never lets two concurrent adjustments take the last units", async () => {
    const business = await createTestBusiness();
    const locationId = await locationOf(business);
    const setup = sql();
    const first = sql();
    const second = sql();
    try {
      const { variantId, unitId } = await createVariant(setup, business, "RACE-10");
      const seed = await postAdjustment(setup, business, locationId, [{ variantId, unitId, delta: "10", costPaisa: 1 }], "opening");
      await setup`SELECT post_stock_adjustment(${seed}, ${business.ownerId})`;
      const a = await postAdjustment(setup, business, locationId, [{ variantId, unitId, delta: "-10" }], "damage");
      const b = await postAdjustment(setup, business, locationId, [{ variantId, unitId, delta: "-10" }], "theft");

      const results = await Promise.allSettled([
        first`SELECT post_stock_adjustment(${a}, ${business.ownerId})`,
        second`SELECT post_stock_adjustment(${b}, ${business.ownerId})`,
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await balance(setup, variantId, locationId)).on_hand).toBe("0.000");
    } finally {
      await Promise.all([setup.end(), first.end(), second.end()]);
    }
  });

  it("enforces unique barcodes and SKUs per business, one base unit, and tenant-scoped references", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const client = sql();
    try {
      const a = await createVariant(client, shopA, "SAME-SKU");
      const b = await createVariant(client, shopB, "SAME-SKU");
      expect(a.variantId).not.toBe(b.variantId);
      await expect(createVariant(client, shopA, "same-sku")).rejects.toThrow(/product_variants_sku_uidx/);

      const [carton] = await client<{ id: string }[]>`SELECT id FROM units WHERE business_id = ${shopA.businessId} AND name = 'Carton'`;
      await client`
        INSERT INTO product_units (business_id, variant_id, unit_id, factor_to_base, is_base, barcode)
        VALUES (${shopA.businessId}, ${a.variantId}, ${a.unitId}, 1, true, '8964000000017')
      `;
      await expect(client`
        INSERT INTO product_units (business_id, variant_id, unit_id, factor_to_base, barcode)
        VALUES (${shopA.businessId}, ${a.variantId}, ${carton.id}, 200, '8964000000017')
      `).rejects.toThrow(/product_units_barcode_uidx/);
      await expect(client`
        INSERT INTO product_units (business_id, variant_id, unit_id, factor_to_base, is_base)
        VALUES (${shopA.businessId}, ${a.variantId}, ${carton.id}, 200, true)
      `).rejects.toThrow();
      await client`
        INSERT INTO product_units (business_id, variant_id, unit_id, factor_to_base, barcode)
        VALUES (${shopB.businessId}, ${b.variantId}, ${b.unitId}, 1, '8964000000017')
      `;

      const locationB = await locationOf(shopB);
      await expect(client`
        INSERT INTO stock_ledger (business_id, variant_id, location_id, qty_base, doc_type, doc_id)
        VALUES (${shopB.businessId}, ${a.variantId}, ${locationB}, 5, 'test', ${randomUUID()})
      `).rejects.toThrow(/foreign key/);
    } finally {
      await client.end();
    }
  });

  it("converts cartons to base pieces the same way the opening-stock example expects", () => {
    expect(formatQuantity(toBaseQuantity(parseQuantity("10"), parseQuantity("200")))).toBe("2000");
  });
});
