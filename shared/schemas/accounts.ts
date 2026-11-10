import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as yyyy-mm-dd");
const paisa = z.number().int().min(1, "Enter an amount more than zero").max(100_000_000_000_000);

export const accountKinds = ["cash", "bank", "wallet"] as const;
export type AccountKind = (typeof accountKinds)[number];
export const accountKindLabels: Record<AccountKind, string> = { cash: "Cash box", bank: "Bank account", wallet: "Wallet" };

/** A new account, with what it holds today (it can be negative for an overdraft). */
export const accountSchema = z.object({
  name: z.string().trim().min(1, "Give the account a name").max(100),
  kind: z.enum(accountKinds),
  openingBalancePaisa: z.number().int().min(-100_000_000_000_000).max(100_000_000_000_000).default(0),
});
export type AccountInput = z.input<typeof accountSchema>;

export const accountUpdateSchema = z.object({ name: z.string().trim().min(1).max(100), active: z.boolean().default(true) });

/** A deposit or withdrawal that is not a transfer or an expense: a cheque cleared, a bank charge, interest. */
export const accountEntrySchema = z.object({
  direction: z.enum(["deposit", "withdrawal"]),
  amountPaisa: paisa,
  memo: z.string().trim().min(1, "Say what this is for").max(300),
  entryDate: isoDate.optional(),
});
export type AccountEntryInput = z.input<typeof accountEntrySchema>;

/** Money from one account to another, or from the register's open shift into an account (a bank deposit). */
export const accountTransferSchema = z.object({
  fromAccountId: z.string().uuid().optional(),
  fromShiftId: z.string().uuid().optional(),
  toAccountId: z.string().uuid(),
  amountPaisa: paisa,
  transferDate: isoDate.optional(),
  memo: z.string().trim().max(300).default(""),
}).refine((value) => Boolean(value.fromAccountId) !== Boolean(value.fromShiftId), { message: "Move money from an account or from the register, not both", path: ["fromAccountId"] });
export type AccountTransferInput = z.input<typeof accountTransferSchema>;

export const expenseCategorySchema = z.object({ name: z.string().trim().min(1, "Give the category a name").max(100), active: z.boolean().default(true) });

export const expenseSchema = z.object({
  categoryId: z.string().uuid(),
  amountPaisa: paisa,
  expenseDate: isoDate.optional(),
  paidFrom: z.enum(["account", "register"]),
  accountId: z.string().uuid().optional(),
  /** The open shift whose drawer the money came out of. */
  shiftId: z.string().uuid().optional(),
  payee: z.string().trim().max(200).default(""),
  reference: z.string().trim().max(100).default(""),
  note: z.string().trim().max(1000).default(""),
  branchId: z.string().uuid().optional(),
}).refine((value) => (value.paidFrom === "account" ? Boolean(value.accountId) && !value.shiftId : Boolean(value.shiftId) && !value.accountId), {
  message: "Choose the account the money came from, or the open register",
  path: ["accountId"],
});
export type ExpenseInput = z.input<typeof expenseSchema>;

export const reverseExpenseSchema = z.object({
  reason: z.string().trim().min(1, "Say why the expense is being reversed").max(300),
  /** For an expense paid from the register: the open shift the money goes back into. */
  shiftId: z.string().uuid().optional(),
});
