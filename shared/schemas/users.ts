import { z } from "zod";
import { pinSchema } from "./auth";

export const userCreateSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(160),
  roleId: z.string().uuid(),
  branchIds: z.array(z.string().uuid()).min(1).refine((ids) => new Set(ids).size === ids.length, "Branches cannot be duplicated"),
  pin: pinSchema.optional(),
});

export const userUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  roleId: z.string().uuid().optional(),
  branchIds: z.array(z.string().uuid()).min(1).refine((ids) => new Set(ids).size === ids.length, "Branches cannot be duplicated").optional(),
  active: z.boolean().optional(),
  pin: pinSchema.optional(),
});

export const roleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissionKeys: z.array(z.string()).max(200).refine((keys) => new Set(keys).size === keys.length, "Permissions cannot be duplicated"),
});
