import { z } from "zod";
import { parseQuantity } from "../units";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as yyyy-mm-dd");
const quantity = z.string().trim().refine((text) => {
  try {
    return parseQuantity(text) > 0;
  } catch {
    return false;
  }
}, "Enter a quantity such as 12 or 2.5");
const cost = z.number().int().min(0).max(100_000_000_000_000);

/** An item on an order: the unit it is bought in, how many, and the price of one such unit. */
export const purchaseLineSchema = z.object({ variantId: uuid, unitId: uuid, quantity, unitCostPaisa: cost });

export const purchaseOrderSchema = z.object({
  supplierId: uuid,
  /** Where the goods are to be received. */
  locationId: uuid,
  orderDate: isoDate.optional(),
  expectedDate: isoDate.nullable().default(null),
  note: z.string().trim().max(1000).default(""),
  lines: z.array(purchaseLineSchema).min(1, "Add at least one item").max(200),
});
export type PurchaseOrderInput = z.input<typeof purchaseOrderSchema>;

/**
 * One line of a goods receipt. Against an order it names the order line and how many came (in the unit the line was ordered in);
 * the price defaults to the order's and may be changed to what the supplier really charged. Without an order it names the SKU,
 * the unit and the price.
 */
export const receiptLineSchema = z.object({
  orderLineId: uuid.optional(),
  variantId: uuid.optional(),
  unitId: uuid.optional(),
  quantity,
  unitCostPaisa: cost.optional(),
});

export const goodsReceiptSchema = z.object({
  supplierId: uuid,
  locationId: uuid,
  orderId: uuid.nullable().default(null),
  /** The supplier's delivery challan or invoice number. */
  supplierRef: z.string().trim().max(100).default(""),
  note: z.string().trim().max(1000).default(""),
  lines: z.array(receiptLineSchema).min(1, "Add at least one item").max(200),
});
export type GoodsReceiptInput = z.input<typeof goodsReceiptSchema>;
