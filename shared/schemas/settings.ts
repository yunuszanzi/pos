import { z } from "zod";

export const settingsSchema = z.object({
  currency: z.literal("PKR").default("PKR"),
  timezone: z.literal("Asia/Karachi").default("Asia/Karachi"),
  dateFormat: z.enum(["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"]).default("dd/MM/yyyy"),
  amountRounding: z.number().int().min(0).max(2).default(2),
  sessionTimeoutMinutes: z.number().int().min(5).max(240).default(30),
  posSessionTimeoutHours: z.number().int().min(1).max(24).default(12),
});
