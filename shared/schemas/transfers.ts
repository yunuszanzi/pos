import { z } from "zod";
import { saleQuantitySchema } from "./sales";

/** Goods moving from one location to another. Each line is an item and how many of one of its units. */
export const stockTransferSchema = z.object({
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  note: z.string().trim().max(1000).default(""),
  lines: z.array(z.object({ variantId: z.string().uuid(), unitId: z.string().uuid(), quantity: saleQuantitySchema })).min(1, "Add at least one item").max(200),
}).refine((value) => value.fromLocationId !== value.toLocationId, { message: "Choose two different locations", path: ["toLocationId"] });
export type StockTransferInput = z.input<typeof stockTransferSchema>;

/** What actually arrived. A line left out arrived in full; a quantity is in the unit the line was sent in. */
export const receiveTransferSchema = z.object({
  note: z.string().trim().max(1000).default(""),
  lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, "Use digits and one decimal point") })).max(200).default([]),
});
export type ReceiveTransferInput = z.input<typeof receiveTransferSchema>;

export const transferStatuses = ["requested", "dispatched", "received", "cancelled"] as const;
export type TransferStatus = (typeof transferStatuses)[number];
export const transferStatusLabels: Record<TransferStatus, string> = { requested: "Requested", dispatched: "In transit", received: "Received", cancelled: "Cancelled" };
