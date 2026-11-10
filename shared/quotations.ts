import type { QuotationStatus } from "./schemas/quotations";
import { divideRounded } from "./money";
import { priceCart, type PricedCart, type TaxMode } from "./pricing";
import { parseQuantity, type Milli } from "./units";

export const quotationStatusLabels: Record<QuotationStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  converted: "Converted",
  revised: "Replaced by a newer revision",
};

/** The message that goes with a quotation shared on WhatsApp. The person sends it; nothing is sent from the server. */
export function quotationShareMessage(input: { businessName: string; number: string; customerName: string; totalText: string; validUntilText: string }): string {
  return `Dear ${input.customerName}, ${input.businessName} quotation ${input.number} for ${input.totalText}, valid until ${input.validUntilText}.`;
}

// ---------------------------------------------------------------- converting a quotation (FR-QUO-04)


/** The stored figures of one quotation line: what the quotation promised, in the unit it was written in. */
export type QuotedLine = {
  id: string;
  quantity: string;
  unitPricePaisa: number;
  lineDiscountPaisa: number;
  taxRateBps: number;
};

export type ConversionPick = { quotationLineId: string; quantityMilli: Milli };

/**
 * Prices the part of a quotation that is being turned into an order or an invoice, keeping what was quoted: the same unit price and
 * tax rate, and the discounts in proportion to the quantity taken (a line taken whole keeps its discount to the paisa). The
 * quotation's whole-quote discount is shared out by value. Taking everything gives exactly the quotation's own total.
 */
export function priceConversion(input: { taxMode: TaxMode; lines: QuotedLine[]; invoiceDiscountPaisa: number; picks: ConversionPick[] }): PricedCart {
  const byId = new Map(input.lines.map((line) => [line.id, line]));
  const afterLineDiscount = (line: QuotedLine, milli: Milli) => {
    const gross = Number(divideRounded(BigInt(milli) * BigInt(line.unitPricePaisa), 1000n));
    return gross - scaledDiscount(line, milli);
  };
  const quotedTotal = input.lines.reduce((sum, line) => sum + afterLineDiscount(line, parseQuantity(line.quantity)), 0);
  const takenTotal = input.picks.reduce((sum, pick) => sum + afterLineDiscount(byId.get(pick.quotationLineId)!, pick.quantityMilli), 0);
  const invoiceDiscount = input.invoiceDiscountPaisa > 0 && quotedTotal > 0
    ? Number(divideRounded(BigInt(input.invoiceDiscountPaisa) * BigInt(takenTotal), BigInt(quotedTotal)))
    : 0;
  return priceCart({
    taxMode: input.taxMode,
    cashRounding: 0,
    invoiceDiscount: invoiceDiscount > 0 ? { type: "fixed", paisa: invoiceDiscount } : null,
    lines: input.picks.map((pick) => {
      const line = byId.get(pick.quotationLineId)!;
      const discount = scaledDiscount(line, pick.quantityMilli);
      return { qtyMilli: pick.quantityMilli, unitPricePaisa: line.unitPricePaisa, taxRateBps: line.taxRateBps, discount: discount > 0 ? { type: "fixed" as const, paisa: discount } : null };
    }),
  });
}

function scaledDiscount(line: QuotedLine, milli: Milli): number {
  const quoted = parseQuantity(line.quantity);
  if (line.lineDiscountPaisa === 0) return 0;
  return milli === quoted ? line.lineDiscountPaisa : Number(divideRounded(BigInt(line.lineDiscountPaisa) * BigInt(milli), BigInt(quoted)));
}
