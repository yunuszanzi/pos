import { z } from "zod";

const paisa = z.number().int().min(0).max(100_000_000_000_000);

export const openShiftSchema = z.object({ openingFloatPaisa: paisa });

/** The cash counted when closing, by denomination if the cashier counted that way (note value in rupees -> number of notes). */
export const closeShiftSchema = z.object({
  countedPaisa: paisa,
  countedBreakdown: z.record(z.string().regex(/^\d{1,6}$/), z.number().int().min(0).max(1_000_000)).optional(),
  note: z.string().trim().max(500).default(""),
});

export const cashMovementSchema = z.object({
  kind: z.enum(["cash_in", "cash_out"]),
  amountPaisa: paisa.refine((value) => value > 0, "Enter an amount more than zero"),
  reason: z.string().trim().min(1, "Give a reason").max(300),
});
