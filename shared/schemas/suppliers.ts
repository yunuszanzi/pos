import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).default("");
const phone = z.string().trim().max(20).regex(/^[0-9+\-() ]*$/, "Use digits, spaces, + - ( )").default("");
const taxNumber = z.string().trim().max(20).regex(/^[0-9A-Za-z-]*$/, "Letters, digits and dashes only")
  .transform((value) => value || null).nullable().default(null);

export const supplierSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200),
  contactPerson: text(200),
  phone,
  whatsapp: phone,
  email: z.string().trim().max(200).refine((value) => !value || z.string().email().safeParse(value).success, "Enter a valid email").default(""),
  address: text(500),
  ntn: taxNumber,
  strn: taxNumber,
  registered: z.boolean().default(false),
  termsDays: z.number().int().min(0).max(365).default(0),
  notes: text(1000),
  active: z.boolean().optional(),
});
export type SupplierInput = z.input<typeof supplierSchema>;
