import { z } from "zod";

/** A count of what is on the shelf: zero is a real answer ("none left"), a negative number is not. */
export const countQuantitySchema = z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, "Use digits and one decimal point, up to 3 decimals");

/** Start a count of one location: every stocked item (full) or the items chosen (partial, a cycle count). */
export const startStockCountSchema = z.object({
  locationId: z.string().uuid(),
  scope: z.enum(["full", "partial"]),
  variantIds: z.array(z.string().uuid()).max(500).default([]),
  note: z.string().trim().max(500).default(""),
}).refine((value) => value.scope === "full" || value.variantIds.length > 0, { message: "Choose at least one item to count", path: ["variantIds"] });
export type StartStockCountInput = z.input<typeof startStockCountSchema>;

/** Counts typed in. `set` replaces what was counted for the item; `add` adds to it (counting a pile in several goes). */
export const countEntriesSchema = z.object({
  mode: z.enum(["set", "add"]).default("set"),
  entries: z.array(z.object({ variantId: z.string().uuid(), unitId: z.string().uuid(), quantity: countQuantitySchema })).min(1).max(200),
});
export type CountEntriesInput = z.input<typeof countEntriesSchema>;

/** One scan of a barcode adds one of the unit that barcode stands for (a carton barcode counts a carton), or the quantity given. */
export const scanCountSchema = z.object({ code: z.string().trim().min(1).max(100), quantity: countQuantitySchema.default("1") });
export type ScanCountInput = z.input<typeof scanCountSchema>;

export const addCountItemsSchema = z.object({ variantIds: z.array(z.string().uuid()).min(1).max(500) });
export const countNoteSchema = z.object({ note: z.string().trim().max(500).default("") });

export const stockCountStatuses = ["counting", "submitted", "approved", "cancelled"] as const;
export type StockCountStatus = (typeof stockCountStatuses)[number];
export const stockCountStatusLabels: Record<StockCountStatus, string> = { counting: "Being counted", submitted: "Waiting for review", approved: "Approved", cancelled: "Cancelled" };
