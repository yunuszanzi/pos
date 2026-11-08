import { z } from "zod";

export const chequeStatuses = ["received", "deposited", "cleared", "bounced"] as const;
export type ChequeStatus = (typeof chequeStatuses)[number];

export const chequeStatusLabels: Record<ChequeStatus, string> = {
  received: "In hand",
  deposited: "Deposited",
  cleared: "Cleared",
  bounced: "Bounced",
};

/** A cheque taken from a customer. The date is the one written on it, which is in the future for a post-dated cheque. */
export const receiveChequeSchema = z.object({
  customerId: z.string().uuid(),
  chequeNo: z.string().trim().min(1, "Enter the cheque number").max(40),
  bank: z.string().trim().min(1, "Enter the bank").max(100),
  amountPaisa: z.number().int().min(1, "Enter an amount more than zero").max(100_000_000_000_000),
  chequeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as yyyy-mm-dd"),
  note: z.string().trim().max(500).default(""),
});
export type ReceiveChequeInput = z.input<typeof receiveChequeSchema>;

export const bounceChequeSchema = z.object({ reason: z.string().trim().min(1, "Say why it bounced").max(300) });
