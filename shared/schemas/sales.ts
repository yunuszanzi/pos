import { z } from "zod";
import { pinSchema } from "./auth";

const paisa = z.number().int().min(0).max(100_000_000_000_000);

export const discountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("percent"), bps: z.number().int().min(0).max(10000) }),
  z.object({ type: z.literal("fixed"), paisa }),
]);

/** A positive quantity in the unit being sold, up to 3 decimals. */
export const saleQuantitySchema = z.string().trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, "Use a number with up to 3 decimals")
  .refine((value) => Number(value) > 0, "Quantity must be more than zero");

export const saleLineSchema = z.object({
  variantId: z.string().uuid(),
  unitId: z.string().uuid(),
  quantity: saleQuantitySchema,
  /** Only honoured for users with sales.price_override; otherwise the shelf price is used and a different price is refused. */
  unitPricePaisa: paisa.optional(),
  discount: discountSchema.nullish(),
});

export const postSaleSchema = z.object({
  shiftId: z.string().uuid(),
  /** Empty for a walk-in. A named customer buys at their price tier. */
  customerId: z.string().uuid().nullish(),
  lines: z.array(saleLineSchema).min(1).max(200),
  invoiceDiscount: discountSchema.nullish(),
  /**
   * What each customer handed over; only cash may be more than what is due, the rest is change. A named customer with credit
   * may pay less than the bill, or nothing at all, and the rest goes on their account (khata).
   */
  payments: z.array(z.object({
    methodId: z.string().uuid(),
    amountPaisa: paisa.refine((value) => value > 0, "Enter an amount more than zero"),
    reference: z.string().trim().max(100).default(""),
  })).max(10),
  /** A manager who agreed to a discount above the cashier's limit, or to credit above the limit or for an overdue customer. */
  approval: z.object({ managerEmail: z.string().email(), pin: pinSchema }).optional(),
  /** What the till showed. If the server works out something else (a price changed meanwhile) the sale is refused, not posted. */
  expectedTotalPaisa: paisa.optional(),
});

export type PostSaleInput = z.input<typeof postSaleSchema>;
