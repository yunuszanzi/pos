import { z } from "zod";
import { saleQuantitySchema } from "./sales";

export const restockChoices = ["sellable", "damaged", "write_off"] as const;
export type RestockChoice = (typeof restockChoices)[number];
export const restockLabels: Record<RestockChoice, string> = {
  sellable: "Back on the shelf",
  damaged: "Damaged stock",
  write_off: "Throw away",
};

const returnLineSchema = z.object({
  /** A line of the invoice being returned against. Without a receipt, name the product instead. */
  originalLineId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  /** In the unit it was sold in. */
  quantity: saleQuantitySchema,
  restockTo: z.enum(restockChoices),
  reason: z.string().trim().max(200).default(""),
});

export const postReturnSchema = z.object({
  shiftId: z.string().uuid(),
  /** The invoice the goods were bought on. Without it the return is at today's price and a manager must approve. */
  invoiceId: z.string().uuid().optional(),
  /** Only for a return without a receipt; a return against an invoice goes to that invoice's customer. */
  customerId: z.string().uuid().optional(),
  lines: z.array(returnLineSchema).min(1).max(200),
  reason: z.string().trim().max(200).default(""),
  refund: z.object({
    /** A payment method to hand the money back by. Leave out to put it on the customer's account (khata or store credit). */
    methodId: z.string().uuid().optional(),
    reference: z.string().trim().max(100).default(""),
  }),
  /** A manager who agreed to a return after the window, or without a receipt. */
  approval: z.object({ managerEmail: z.string().email(), pin: z.string().regex(/^\d{4,8}$/) }).optional(),
}).superRefine((value, context) => {
  value.lines.forEach((line, index) => {
    const withReceipt = Boolean(value.invoiceId);
    if (withReceipt && !line.originalLineId) context.addIssue({ code: "custom", path: ["lines", index], message: "Choose a line of the invoice" });
    if (!withReceipt && (!line.variantId || !line.unitId)) context.addIssue({ code: "custom", path: ["lines", index], message: "Choose a product and unit" });
  });
  if (value.invoiceId && value.customerId) context.addIssue({ code: "custom", path: ["customerId"], message: "A return against an invoice goes to that invoice's customer" });
});

export type PostReturnInput = z.input<typeof postReturnSchema>;
