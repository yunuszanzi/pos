import { z } from "zod";

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max).default("");
const phone = z.string().trim().max(20).regex(/^[0-9+\-() ]*$/, "Use digits, spaces, + - ( )").default("");
const taxNumber = z.string().trim().max(20).regex(/^[0-9A-Za-z-]*$/, "Letters, digits and dashes only")
  .transform((value) => value || null).nullable().default(null);

/** "42101-1234567-1" or "4210112345671" -> "4210112345671"; blank -> null. */
const cnic = z.string().trim().nullish().transform((value, context) => {
  const digits = (value ?? "").replace(/[-\s]/g, "");
  if (!digits) return null;
  if (!/^\d{13}$/.test(digits)) {
    context.addIssue({ code: "custom", message: "CNIC has 13 digits, for example 42101-1234567-1" });
    return z.NEVER;
  }
  return digits;
});

export const customerSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200),
  businessName: text(200),
  phone,
  phone2: phone,
  whatsapp: phone,
  email: z.string().trim().max(200).refine((value) => !value || z.string().email().safeParse(value).success, "Enter a valid email").default(""),
  address: text(500),
  areaId: uuid.nullable().default(null),
  groupId: uuid.nullable().default(null),
  cnic,
  ntn: taxNumber,
  strn: taxNumber,
  registered: z.boolean().default(false),
  priceListId: uuid.nullable().default(null),
  creditLimitPaisa: z.number().int().min(0).max(100_000_000_000_000).default(0),
  termsDays: z.number().int().min(0).max(365).default(0),
  notes: text(1000),
  active: z.boolean().optional(),
});

/** The few fields a cashier fills in when adding a customer at the till. Everything else is set later by someone who may manage customers. */
export const quickCustomerSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200),
  phone: phone.refine((value) => value.length >= 7, "Enter the phone number"),
});

export const areaSchema = z.object({ name: z.string().trim().min(1).max(100), active: z.boolean().optional() });
export const customerGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  priceListId: uuid.nullable().default(null),
  active: z.boolean().optional(),
});

export type CustomerInput = z.input<typeof customerSchema>;
