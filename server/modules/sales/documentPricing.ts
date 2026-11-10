import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { businessSettings, customerGroups, customers, priceListItems, priceLists, roles } from "../../../db/schema";
import { effectivePriceListId, tierPrice, type PriceListItem } from "../../../shared/priceLists";
import { discountsOverLimit, priceCart, PricingError, type PricingInput } from "../../../shared/pricing";
import type { z } from "zod";
import type { saleLineSchema, discountSchema } from "../../../shared/schemas/sales";
import { formatQuantity, parseQuantity, toBaseQuantity } from "../../../shared/units";
import { db } from "../../lib/db";
import { apiError } from "../../lib/http";
import { hasPermission, type Principal } from "../../lib/permissions";
import { quantityText } from "../products/service";

// Prices a document that is not a till sale (a quotation, a sales order, a back-office invoice) the way the till prices a sale: from
// the catalogue as it is now, at the customer's tier, with the same discount limits. The browser's idea of a price is never trusted.

type LineFacts = {
  variant_id: string; unit_id: string; product_name: string; variant_name: string; sku: string; unit_name: string; hs_code: string | null;
  factor_to_base: string; sale_price_paisa: string; rate_bps: number | null;
};

export type DocumentLineInput = z.infer<typeof saleLineSchema>;
export type DocumentDiscount = z.infer<typeof discountSchema>;

/** The rows of a function payload (the shape of the sales_line_input type) and the totals they add up to. */
export type PricedDocument = {
  taxMode: "inclusive" | "exclusive";
  customerId: string | null;
  customerName: string;
  amounts: {
    gross_paisa: number; line_discount_paisa: number; invoice_discount_paisa: number; taxable_paisa: number; tax_paisa: number; rounding_paisa: number; total_paisa: number;
  };
  lines: Array<Record<string, unknown>>;
};

export async function priceDocument(
  context: Context,
  principal: Principal,
  input: { customerId?: string | null; lines: DocumentLineInput[]; invoiceDiscount?: DocumentDiscount | null },
): Promise<{ response: Response } | { priced: PricedDocument }> {
  const businessId = principal.businessId!;
  const [settings] = await db.select().from(businessSettings).where(eq(businessSettings.businessId, businessId)).limit(1);
  if (!settings) return { response: apiError(context, 409, "SETTINGS_MISSING", "The business settings are missing") };

  const keys = input.lines.map((line) => sql`(${line.variantId}::uuid, ${line.unitId}::uuid)`);
  const facts = await db.execute<LineFacts>(sql`
    select v.id as variant_id, pu.unit_id, p.name as product_name, v.variant_name, v.sku, u.name as unit_name, p.hs_code,
           pu.factor_to_base::text, pu.sale_price_paisa::text, tc.rate_bps
    from product_units pu
    join product_variants v on v.id = pu.variant_id and v.business_id = pu.business_id and v.active
    join products p on p.id = v.product_id and p.active
    join units u on u.id = pu.unit_id
    left join tax_categories tc on tc.id = p.tax_category_id
    where pu.business_id = ${businessId} and (pu.variant_id, pu.unit_id) in (${sql.join(keys, sql`, `)})
  `);
  const factsOf = (variantId: string, unitId: string) => facts.find((row) => row.variant_id === variantId && row.unit_id === unitId);
  const missing = input.lines.findIndex((line) => !factsOf(line.variantId, line.unitId));
  if (missing >= 0) return { response: apiError(context, 422, "INVALID_LINE", `Line ${missing + 1} is not an active product sold in that unit`) };

  // A registered customer is priced at their tier: their own price list, else their group's.
  let customerId: string | null = null;
  let customerName = "";
  let tierItems: PriceListItem[] = [];
  if (input.customerId) {
    const [customer] = await db.select().from(customers).where(and(eq(customers.id, input.customerId), eq(customers.businessId, businessId), eq(customers.active, true))).limit(1);
    if (!customer) return { response: apiError(context, 422, "INVALID_CUSTOMER", "This customer is not available") };
    customerId = customer.id;
    customerName = customer.name;
    const [group] = customer.groupId ? await db.select().from(customerGroups).where(eq(customerGroups.id, customer.groupId)).limit(1) : [];
    const listId = effectivePriceListId(customer, group);
    if (listId) {
      const rows = await db.select({ variantId: priceListItems.variantId, unitId: priceListItems.unitId, min: priceListItems.minQuantity, price: priceListItems.pricePaisa })
        .from(priceListItems).innerJoin(priceLists, eq(priceLists.id, priceListItems.priceListId))
        .where(and(eq(priceListItems.priceListId, listId), eq(priceListItems.businessId, businessId), eq(priceLists.active, true)));
      tierItems = rows.map((row) => ({ variantId: row.variantId, unitId: row.unitId, minQuantityMilli: parseQuantity(quantityText(row.min)), pricePaisa: row.price }));
    }
  }

  const mayOverridePrice = hasPermission(principal, "sales.price_override");
  const pricingInput: PricingInput = { taxMode: settings.taxMode, cashRounding: 0, invoiceDiscount: input.invoiceDiscount ?? null, lines: [] };
  for (const [index, line] of input.lines.entries()) {
    const fact = factsOf(line.variantId, line.unitId)!;
    const qtyMilli = parseQuantity(line.quantity);
    const shelfPrice = tierPrice(tierItems, line.variantId, line.unitId, qtyMilli) ?? Number(fact.sale_price_paisa);
    if (line.unitPricePaisa !== undefined && line.unitPricePaisa !== shelfPrice && !mayOverridePrice) {
      return { response: apiError(context, 403, "PRICE_OVERRIDE_DENIED", `Line ${index + 1}: you may not change the price`) };
    }
    pricingInput.lines.push({ qtyMilli, unitPricePaisa: line.unitPricePaisa ?? shelfPrice, taxRateBps: fact.rate_bps ?? 0, discount: line.discount ?? null });
  }
  let priced;
  try {
    priced = priceCart(pricingInput);
  } catch (error) {
    if (error instanceof PricingError) return { response: apiError(context, 422, error.code, error.message) };
    throw error;
  }

  // Discounts follow the same limits as at the till; there is no manager PIN here, so above the limit it is refused.
  const hasDiscount = Boolean(input.invoiceDiscount) || input.lines.some((line) => line.discount);
  if (hasDiscount) {
    if (!hasPermission(principal, "sales.discount")) return { response: apiError(context, 403, "DISCOUNT_DENIED", "You may not give discounts") };
    if (!hasPermission(principal, "sales.discount.above_limit")) {
      const [role] = await db.select({ limit: roles.maxDiscountBps }).from(roles).where(eq(roles.id, principal.roleId!)).limit(1);
      if (discountsOverLimit(pricingInput, priced, role?.limit ?? 0).length) {
        return { response: apiError(context, 403, "DISCOUNT_APPROVAL_REQUIRED", "This discount is more than you may give") };
      }
    }
  }

  return {
    priced: {
      taxMode: settings.taxMode, customerId, customerName,
      amounts: {
        gross_paisa: priced.grossPaisa, line_discount_paisa: priced.lineDiscountPaisa, invoice_discount_paisa: priced.invoiceDiscountPaisa,
        taxable_paisa: priced.taxablePaisa, tax_paisa: priced.taxPaisa, rounding_paisa: priced.roundingPaisa, total_paisa: priced.totalPaisa,
      },
      lines: input.lines.map((line, index) => {
        const fact = factsOf(line.variantId, line.unitId)!;
        const entered = parseQuantity(line.quantity);
        const base = toBaseQuantity(entered, parseQuantity(quantityText(fact.factor_to_base)));
        const priceLine = pricingInput.lines[index];
        const out = priced.lines[index];
        return {
          line_no: index + 1, variant_id: line.variantId, unit_id: line.unitId, product_name: fact.product_name, variant_name: fact.variant_name, sku: fact.sku,
          unit_name: fact.unit_name, hs_code: fact.hs_code, qty_entered: formatQuantity(entered), factor_to_base: quantityText(fact.factor_to_base), qty_base: formatQuantity(base),
          unit_price_paisa: priceLine.unitPricePaisa, gross_paisa: out.grossPaisa, line_discount_paisa: out.lineDiscountPaisa, invoice_discount_share_paisa: out.invoiceDiscountSharePaisa,
          net_paisa: out.netPaisa, tax_rate_bps: priceLine.taxRateBps, tax_included: settings.taxMode === "inclusive", taxable_paisa: out.taxablePaisa, tax_paisa: out.taxPaisa,
          total_paisa: out.totalPaisa,
        };
      }),
    },
  };
}
