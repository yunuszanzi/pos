import { z } from "zod";

export const settingsSchema = z.object({
  currency: z.literal("PKR").default("PKR"),
  timezone: z.literal("Asia/Karachi").default("Asia/Karachi"),
  dateFormat: z.enum(["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"]).default("dd/MM/yyyy"),
  // Amounts are always shown and rounded to 2 decimal places (whole paisa). Kept in the shape so old clients still work.
  amountRounding: z.literal(2).default(2),
  sessionTimeoutMinutes: z.number().int().min(5).max(240).default(30),
  posSessionTimeoutHours: z.number().int().min(1).max(24).default(12),
  // Stock adjustments worth more than this wait for someone with inventory.approve. Paisa; default PKR 10,000.
  adjustmentApprovalThresholdPaisa: z.number().int().min(0).max(100_000_000_000).default(1_000_000),
});
