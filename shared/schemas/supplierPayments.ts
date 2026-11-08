import { z } from "zod";
import { parseQuantity } from "../units";

const uuid = z.string().uuid();
const paisa = z.number().int().min(1, "Enter an amount more than zero").max(100_000_000_000_000);

/**
 * Money paid to a supplier. By default it settles the oldest bills first; with `allocations` the payer chooses which bills it
 * settles. Whatever is not allocated stays on the account as an advance (a credit with the supplier).
 */
export const supplierPaymentSchema = z.object({
  supplierId: uuid,
  methodId: uuid,
  amountPaisa: paisa,
  reference: z.string().trim().max(100).default(""),
  note: z.string().trim().max(500).default(""),
  allocations: z.array(z.object({ billId: uuid, amountPaisa: paisa })).max(200).optional(),
});
export type SupplierPaymentInput = z.input<typeof supplierPaymentSchema>;

/**
 * Goods going back to a supplier, from a goods receipt. Each line names the receipt line and how many go back (in the unit it was
 * received in). The credit defaults to the billed price when the goods were billed, else the receipt's, and the tax rate to the
 * bill's; both can be changed to what the supplier agrees to credit.
 */
export const purchaseReturnSchema = z.object({
  receiptId: uuid,
  reason: z.string().trim().max(500).default(""),
  lines: z.array(z.object({
    receiptLineId: uuid,
    quantity: z.string().trim().refine((text) => {
      try {
        return parseQuantity(text) > 0;
      } catch {
        return false;
      }
    }, "Enter a quantity such as 12 or 2.5"),
    unitCostPaisa: z.number().int().min(0).max(100_000_000_000_000).optional(),
    taxRateBps: z.number().int().min(0).max(10_000).optional(),
  })).min(1, "Choose what is going back").max(200),
});
export type PurchaseReturnInput = z.input<typeof purchaseReturnSchema>;
