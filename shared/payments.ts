import type { Paisa } from "./money";

// Splitting a bill across payment methods (FR-SAL-07). Only cash can be over-tendered: change is cash handed back,
// so a card or wallet payment can never be more than what is still due.

export type TenderKind = "cash" | "other";
export type Tender = { kind: TenderKind; amountPaisa: Paisa };

export type SettledTender = {
  /** Handed over or charged. */
  tenderedPaisa: Paisa;
  /** What counts towards the bill. */
  appliedPaisa: Paisa;
  changePaisa: Paisa;
};

export type Settlement = {
  tenders: SettledTender[];
  paidPaisa: Paisa;
  changePaisa: Paisa;
  /** What is still owed. Zero for a bill that is fully paid. */
  balancePaisa: Paisa;
};

export class PaymentError extends Error {
  constructor(readonly code: "INVALID_TENDER" | "OVERPAID_WITHOUT_CASH" | "NOTHING_DUE", message: string) {
    super(message);
  }
}

export function settleTenders(totalPaisa: Paisa, tenders: Tender[]): Settlement {
  if (!Number.isSafeInteger(totalPaisa) || totalPaisa < 0) throw new PaymentError("INVALID_TENDER", "The bill total is not a valid amount");
  for (const tender of tenders) {
    if (!Number.isSafeInteger(tender.amountPaisa) || tender.amountPaisa <= 0) throw new PaymentError("INVALID_TENDER", "Each payment must be more than zero");
  }

  // Card, wallet and bank payments are charged for exactly what they cover.
  const otherTotal = tenders.filter((tender) => tender.kind === "other").reduce((sum, tender) => sum + tender.amountPaisa, 0);
  if (otherTotal > totalPaisa) throw new PaymentError("OVERPAID_WITHOUT_CASH", "Card, bank and wallet payments cannot be more than the bill; only cash gives change");

  // Cash covers the rest, in the order it was handed over; whatever is beyond the bill is change.
  let cashDue = totalPaisa - otherTotal;
  const settled = tenders.map((tender): SettledTender => {
    if (tender.kind === "other") return { tenderedPaisa: tender.amountPaisa, appliedPaisa: tender.amountPaisa, changePaisa: 0 };
    if (cashDue === 0) throw new PaymentError("NOTHING_DUE", "The bill is already covered; remove the extra cash payment");
    const appliedPaisa = Math.min(tender.amountPaisa, cashDue);
    cashDue -= appliedPaisa;
    return { tenderedPaisa: tender.amountPaisa, appliedPaisa, changePaisa: tender.amountPaisa - appliedPaisa };
  });

  const paidPaisa = settled.reduce((sum, tender) => sum + tender.appliedPaisa, 0);
  return { tenders: settled, paidPaisa, changePaisa: settled.reduce((sum, tender) => sum + tender.changePaisa, 0), balancePaisa: totalPaisa - paidPaisa };
}
