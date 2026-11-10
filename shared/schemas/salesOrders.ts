import { z } from "zod";
import { discountSchema, saleLineSchema, saleQuantitySchema } from "./sales";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as yyyy-mm-dd");
const orderDetails = {
  /** The customer's own order number. */
  customerPo: z.string().trim().max(100).default(""),
  deliveryDate: isoDate.nullish(),
  deliveryAddress: z.string().trim().max(500).default(""),
  note: z.string().trim().max(1000).default(""),
  /** Where the stock is reserved and dispatched from; the branch's store when left out. */
  locationId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
};

/** An order written directly, without a quotation. Priced like a sale, at the customer's tier. */
export const salesOrderSchema = z.object({
  customerId: z.string().uuid(),
  lines: z.array(saleLineSchema).min(1, "Add at least one item").max(200),
  invoiceDiscount: discountSchema.nullish(),
  ...orderDetails,
});
export type SalesOrderInput = z.input<typeof salesOrderSchema>;

/**
 * An order made from a quotation, in whole or in part. The prices are the quotation's. Without `picks` everything not yet ordered is
 * taken; with them, each names a quotation line and how many (in the unit that line was quoted in). A quotation written for a
 * prospect needs `customerId`: an order is always for a customer.
 */
export const convertQuotationSchema = z.object({
  customerId: z.string().uuid().nullish(),
  picks: z.array(z.object({ quotationLineId: z.string().uuid(), quantity: saleQuantitySchema })).min(1).max(200).optional(),
  ...orderDetails,
});
export type ConvertQuotationInput = z.input<typeof convertQuotationSchema>;

export const salesOrderStatuses = ["open", "partly_delivered", "delivered", "closed", "cancelled"] as const;
export type SalesOrderStatus = (typeof salesOrderStatuses)[number];
export const salesOrderStatusLabels: Record<SalesOrderStatus, string> = {
  open: "Open",
  partly_delivered: "Partly delivered",
  delivered: "Delivered",
  closed: "Closed",
  cancelled: "Cancelled",
};
