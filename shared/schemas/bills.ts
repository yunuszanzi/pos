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

/** What the supplier billed for some of a received line: how much (in the unit it was received in), at what price, and the tax rate. */
export const billLineSchema = z.object({
  receiptLineId: uuid,
  quantity,
  unitCostPaisa: z.number().int().min(0).max(100_000_000_000_000),
  /** Input tax as basis points of the line's value: 1800 is 18%. 0 when the supplier charged none. */
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
});

/** Freight, loading or any other charge on the supplier's invoice. It becomes part of what the goods cost. */
export const billChargeSchema = z.object({
  description: z.string().trim().min(1, "Say what the charge is for").max(100),
  amountPaisa: z.number().int().min(1, "Enter an amount more than zero").max(100_000_000_000_000),
});

export const purchaseBillSchema = z.object({
  supplierId: uuid,
  /** The number printed on the supplier's invoice. */
  supplierInvoiceNo: z.string().trim().min(1, "Enter the supplier's invoice number").max(60),
  billDate: isoDate,
  note: z.string().trim().max(1000).default(""),
  lines: z.array(billLineSchema).min(1, "Choose at least one received item to bill").max(200),
  charges: z.array(billChargeSchema).max(20).default([]),
});
export type PurchaseBillInput = z.input<typeof purchaseBillSchema>;
