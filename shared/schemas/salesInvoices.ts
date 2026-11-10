import { z } from "zod";
import { discountSchema, saleLineSchema, saleQuantitySchema } from "./sales";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as yyyy-mm-dd");

/** The usual terms: due on receipt, or in 7, 15 or 30 days. Any whole number of days up to a year is accepted. */
export const paymentTermChoices = [0, 7, 15, 30] as const;

/**
 * A back-office invoice, written for a customer on credit. It comes from one of three places:
 *   - a sales order (`orderId`): bills goods already delivered, in whole or in part (`picks` name order lines);
 *   - a quotation (`quotationId`): the quoted prices; the goods leave with the invoice (`picks` name quotation lines);
 *   - nothing (`customerId` and `lines`): priced like a sale, at the customer's tier; the goods leave with the invoice.
 * Without `picks` everything that can still be billed is billed. Terms default to the customer's own.
 */
export const salesInvoiceSchema = z.object({
  orderId: z.string().uuid().optional(),
  quotationId: z.string().uuid().optional(),
  customerId: z.string().uuid().nullish(),
  picks: z.array(z.object({ lineId: z.string().uuid(), quantity: saleQuantitySchema })).min(1).max(200).optional(),
  lines: z.array(saleLineSchema).min(1).max(200).optional(),
  invoiceDiscount: discountSchema.nullish(),
  termsDays: z.number().int().min(0).max(365).optional(),
  dueDate: isoDate.optional(),
  customerPo: z.string().trim().max(100).default(""),
  note: z.string().trim().max(1000).default(""),
  locationId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
}).refine((value) => [value.orderId, value.quotationId, value.lines].filter((part) => part !== undefined).length === 1, {
  message: "An invoice comes from an order, from a quotation, or from lines you enter, not a mix",
}).refine((value) => value.lines === undefined || Boolean(value.customerId), { message: "Choose the customer", path: ["customerId"] })
  .refine((value) => value.lines === undefined || value.picks === undefined, { message: "Picks only apply to an order or a quotation", path: ["picks"] });
export type SalesInvoiceInput = z.input<typeof salesInvoiceSchema>;
