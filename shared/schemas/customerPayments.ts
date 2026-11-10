import { z } from "zod";

const paisa = z.number().int().min(1, "Enter an amount more than zero").max(100_000_000_000_000);

/**
 * Money received from a customer. By default it settles the oldest invoices first; with `allocations` the cashier chooses
 * which invoices it settles. Whatever is not allocated stays on the customer's account as credit.
 */
export const customerPaymentSchema = z.object({
  customerId: z.string().uuid(),
  methodId: z.string().uuid(),
  amountPaisa: paisa,
  reference: z.string().trim().max(100).default(""),
  note: z.string().trim().max(500).default(""),
  allocations: z.array(z.object({ invoiceId: z.string().uuid(), amountPaisa: paisa })).max(200).optional(),
});

export type CustomerPaymentInput = z.input<typeof customerPaymentSchema>;
