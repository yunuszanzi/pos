import { z } from "zod";

export const pinSchema = z.string().regex(/^\d{4,6}$/, "PIN must contain 4 to 6 digits");

export const authCredentialsSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().optional(),
});

export const pinSwitchSchema = z.object({
  targetEmail: z.string().email(),
  pin: pinSchema,
  terminalId: z.string().uuid(),
});

export const managerOverrideSchema = z.object({
  managerEmail: z.string().email(),
  pin: pinSchema,
  permission: z.string().min(1),
});
