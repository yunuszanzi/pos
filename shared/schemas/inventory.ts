import { z } from "zod";

/** A signed quantity in the entered unit: "10" adds stock, "-2.5" removes it. Never zero. */
export const signedQuantitySchema = z.string().trim()
  .regex(/^-?\d{1,11}(\.\d{1,3})?$/, "Use a number with up to 3 decimals, negative to remove stock")
  .refine((value) => Number(value) !== 0, "Quantity cannot be zero");

export const adjustmentReasons = ["damage", "theft", "expiry", "found", "correction"] as const;

export const stockAdjustmentSchema = z.object({
  locationId: z.string().uuid(),
  reason: z.enum(adjustmentReasons),
  note: z.string().trim().max(500).default(""),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    unitId: z.string().uuid(),
    quantity: signedQuantitySchema,
    /** Cost per entered unit for stock being added. Only honoured for users who can see costs; otherwise the SKU's cost is used. */
    unitCostPaisa: z.number().int().min(0).max(100_000_000_000).optional(),
  })).min(1).max(200),
}).superRefine((adjustment, context) => {
  const seen = new Set<string>();
  adjustment.lines.forEach((line, index) => {
    if (seen.has(line.variantId)) context.addIssue({ code: "custom", path: ["lines", index, "variantId"], message: "Each SKU can appear once; combine the quantities" });
    seen.add(line.variantId);
  });
});

export const rejectAdjustmentSchema = z.object({ reason: z.string().trim().min(1, "Give a reason").max(300) });

export type StockAdjustmentInput = z.input<typeof stockAdjustmentSchema>;
