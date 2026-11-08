import { formatPkr, type Paisa } from "./money";

// What a customer's ledger says in the three ways people ask: a statement for a period, how old the debt is (ageing), and a
// message to send them. All of it is read off ledger entries (debit = they owe us more, credit = they owe us less), so it
// always agrees with the khata page. Pure functions, unit-tested.

export type KhataEntry = {
  docType: "sales_invoice" | "customer_payment" | "sales_return" | "opening_balance" | "adjustment" | string;
  debitPaisa: Paisa;
  creditPaisa: Paisa;
  /** ISO timestamp. */
  at: string;
};

export type StatementSummary = {
  openingPaisa: Paisa;
  invoicesPaisa: Paisa;
  /** Money received: paid at the till at the time of sale, and payments received later. */
  paymentsPaisa: Paisa;
  /** The value of goods taken back. */
  returnsPaisa: Paisa;
  /** Money handed back to the customer for those returns. It puts the balance back up. */
  refundsPaisa: Paisa;
  /** Opening balances and adjustments, net (positive: the customer owes more). */
  otherPaisa: Paisa;
  closingPaisa: Paisa;
};

/**
 * Totals for a statement. `opening` is the balance before the period; `entries` are the ledger entries inside it.
 * closing = opening + invoices − payments − returns + refunds + other, which is the identity the statement is checked against.
 */
export function summariseStatement(openingPaisa: Paisa, entries: KhataEntry[]): StatementSummary {
  const summary: StatementSummary = { openingPaisa, invoicesPaisa: 0, paymentsPaisa: 0, returnsPaisa: 0, refundsPaisa: 0, otherPaisa: 0, closingPaisa: 0 };
  for (const entry of entries) {
    switch (entry.docType) {
      case "sales_invoice":
        summary.invoicesPaisa += entry.debitPaisa;
        summary.paymentsPaisa += entry.creditPaisa;
        break;
      case "customer_payment":
        summary.paymentsPaisa += entry.creditPaisa;
        break;
      case "cheque_bounce":
        // A bounced cheque takes back a payment already counted, so payments received go down by it.
        summary.paymentsPaisa -= entry.debitPaisa;
        break;
      case "sales_return":
        summary.returnsPaisa += entry.creditPaisa;
        summary.refundsPaisa += entry.debitPaisa;
        break;
      default:
        summary.otherPaisa += entry.debitPaisa - entry.creditPaisa;
    }
  }
  summary.closingPaisa = openingPaisa + summary.invoicesPaisa - summary.paymentsPaisa - summary.returnsPaisa + summary.refundsPaisa + summary.otherPaisa;
  return summary;
}

// ---------------------------------------------------------------- ageing

/** Age bands in days: up to 30, 31–60, 61–90, over 90. */
export const ageingBands = ["0–30", "31–60", "61–90", "90+"] as const;

export type Ageing = {
  /** What is owed in each band, oldest debt last. Adds up to `owedPaisa`. */
  bandsPaisa: [Paisa, Paisa, Paisa, Paisa];
  owedPaisa: Paisa;
  /** Credit held for the customer that no debt took up (a negative balance). */
  creditPaisa: Paisa;
  /** Days since the oldest debt still unpaid; 0 when nothing is owed. */
  oldestDays: number;
};

const dayMs = 86_400_000;

/**
 * How old the debt is. Entries must be in posting order. A credit pays the oldest debt first; a debit first uses up any credit
 * the customer was holding, so a return that was then refunded does not look like new debt. What is left unpaid is aged by the
 * date of the entry that created it. Whole days elapsed, as in the return window.
 */
export function ageLedger(entries: KhataEntry[], asOf: Date): Ageing {
  const open: Array<{ at: number; left: Paisa }> = [];
  let credit = 0;
  for (const entry of entries) {
    const at = new Date(entry.at).getTime();
    if (entry.debitPaisa > 0) {
      const used = Math.min(credit, entry.debitPaisa);
      credit -= used;
      if (entry.debitPaisa > used) open.push({ at, left: entry.debitPaisa - used });
    }
    if (entry.creditPaisa > 0) {
      let spare = entry.creditPaisa;
      while (spare > 0 && open.length) {
        const take = Math.min(spare, open[0].left);
        open[0].left -= take;
        spare -= take;
        if (open[0].left === 0) open.shift();
      }
      credit += spare;
    }
  }
  const bandsPaisa: Ageing["bandsPaisa"] = [0, 0, 0, 0];
  let oldestDays = 0;
  for (const debt of open) {
    const days = Math.max(0, Math.floor((asOf.getTime() - debt.at) / dayMs));
    bandsPaisa[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3] += debt.left;
    oldestDays = Math.max(oldestDays, days);
  }
  return { bandsPaisa, owedPaisa: bandsPaisa.reduce((sum, value) => sum + value, 0), creditPaisa: credit, oldestDays };
}

// ---------------------------------------------------------------- WhatsApp

/**
 * A phone number as WhatsApp wants it: digits only, with Pakistan's country code. "0300-1234567", "300 1234567" and
 * "+92 300 1234567" all become 923001234567. Returns null when it cannot be a mobile or landline number.
 */
export function whatsappNumber(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("92")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  return digits.length >= 9 && digits.length <= 11 ? `92${digits}` : null;
}

/** A wa.me link that opens WhatsApp with the message ready to send. The person sends it; nothing is sent from the server. */
export function whatsappLink(phone: string, message: string): string | null {
  const number = whatsappNumber(phone);
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : null;
}

export function reminderMessage(input: { customerName: string; businessName: string; balancePaisa: Paisa; overdueDays?: number }): string {
  const overdue = input.overdueDays && input.overdueDays > 0 ? ` Your oldest unpaid bill is ${input.overdueDays} days old.` : "";
  return `Assalam o Alaikum ${input.customerName}, this is a reminder from ${input.businessName}. Your balance with us is ${formatPkr(input.balancePaisa)}.${overdue} Please pay at your earliest convenience. Thank you.`;
}

export function statementMessage(input: { customerName: string; businessName: string; from: string; to: string; closingPaisa: Paisa }): string {
  return `Assalam o Alaikum ${input.customerName}, your statement from ${input.businessName} for ${input.from} to ${input.to}: balance ${formatPkr(input.closingPaisa)}. Please let us know if anything looks wrong. Thank you.`;
}
