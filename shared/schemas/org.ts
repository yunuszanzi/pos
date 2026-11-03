import { z } from "zod";
import { pinSchema } from "./auth";

export const setupBusinessSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  tradeName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).default(""),
  address: z.string().trim().max(500).default(""),
  ntn: z.string().trim().max(32).nullable().default(null),
  strn: z.string().trim().max(32).nullable().default(null),
  province: z.string().trim().max(80).default(""),
  logoUrl: z.string().url().nullable().default(null),
  receiptFooter: z.string().trim().max(500).default(""),
  ownerPin: pinSchema,
  branchName: z.string().trim().min(1).max(120),
  branchCode: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9_-]+$/),
  locationName: z.string().trim().min(1).max(120),
  terminalName: z.string().trim().min(1).max(120),
  documentPrefix: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9_-]+$/),
});

export const businessUpdateSchema = setupBusinessSchema.pick({
  legalName: true,
  tradeName: true,
  phone: true,
  address: true,
  ntn: true,
  strn: true,
  province: true,
  logoUrl: true,
  receiptFooter: true,
}).partial();

export const branchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9_-]+$/),
  active: z.boolean().optional(),
});

export const locationSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["store", "warehouse", "damaged"]).default("store"),
  active: z.boolean().optional(),
});

export const terminalSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  defaultPrintFormat: z.enum(["pos80", "pos58", "a4", "a5"]).default("pos80"),
  fbrPosId: z.string().trim().max(80).nullable().optional(),
  active: z.boolean().optional(),
});

export const documentSeriesSchema = z.object({
  branchId: z.string().uuid(),
  docType: z.string().trim().min(1).max(40),
  prefix: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9_-]+$/),
  nextNumber: z.number().int().positive(),
});
