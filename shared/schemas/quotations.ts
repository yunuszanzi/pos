import { z } from "zod";
import { discountSchema, saleLineSchema } from "./sales";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as yyyy-mm-dd");

/** A quotation line is a sale line: the unit, how many, and optionally a price and a discount different from the shelf. */
export const quotationLineSchema = saleLineSchema;

export const quotationSchema = z.object({
  /** A registered customer (they quote at their tier price), or leave empty and name a prospect. */
  customerId: z.string().uuid().nullish(),
  prospectName: z.string().trim().max(200).default(""),
  prospectPhone: z.string().trim().max(20).regex(/^[0-9+\-() ]*$/, "Use digits, spaces, + - ( )").default(""),
  quoteDate: isoDate.optional(),
  validUntil: isoDate,
  terms: z.string().trim().max(2000).default(""),
  note: z.string().trim().max(1000).default(""),
  branchId: z.string().uuid().optional(),
  lines: z.array(quotationLineSchema).min(1, "Add at least one item").max(200),
  invoiceDiscount: discountSchema.nullish(),
}).refine((value) => Boolean(value.customerId) || value.prospectName.length > 0, {
  message: "Choose a customer or type the name of the person this is for",
  path: ["prospectName"],
});
export type QuotationInput = z.input<typeof quotationSchema>;

export const quotationStatuses = ["draft", "sent", "accepted", "rejected", "converted", "revised", "expired"] as const;
export type QuotationStatus = (typeof quotationStatuses)[number];
