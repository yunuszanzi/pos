import { z } from "zod";
import { fbrEnvironments, fbrModes } from "../fbr";

const text = (max: number) => z.string().trim().max(max).default("");

/** The FBR settings. The token is not here: it is set on its own and never read back. */
export const fbrConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(fbrModes),
  environment: z.enum(fbrEnvironments),
  sellerNtn: text(20).refine((value) => value === "" || /^[0-9A-Za-z-]+$/.test(value), "Digits and dashes only"),
  sellerStrn: text(30),
  sellerName: text(200),
  sellerProvince: text(60),
  sellerAddress: text(300),
  cancelWindowHours: z.number().int().min(0).max(8760).default(72),
  buyerIdThresholdPaisa: z.number().int().min(0).max(100_000_000_000_000).default(5_000_000),
  /** Switching to production before every sandbox scenario has passed needs the owner to say so. */
  confirmUntested: z.boolean().default(false),
});
export type FbrConfigInput = z.input<typeof fbrConfigSchema>;

export const fbrTokenSchema = z.object({ token: z.string().trim().min(8, "That looks too short to be an FBR token").max(4000) });
export const fbrTerminalSchema = z.object({ fbrPosId: z.string().trim().max(80).default(""), fbrEnabled: z.boolean() });
export const fbrPaymentMethodSchema = z.object({ fbrPaymentCode: z.string().trim().max(40).default("") });
export const fbrTaxCategorySchema = z.object({
  fbrSaleType: z.string().trim().max(120).default(""),
  sroScheduleNo: z.string().trim().max(60).default(""),
  sroItemSerialNo: z.string().trim().max(60).default(""),
});
export const fbrBuyerCheckSchema = z.object({ registrationNo: z.string().trim().min(7).max(20) });
