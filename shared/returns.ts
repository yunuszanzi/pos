import { divideRounded, type Paisa } from "./money";
import type { Milli } from "./units";

// What a return gives back. A return of part of a sold line gives back the same share of everything on that line:
// price, line discount, share of the bill discount and tax. Each amount is rounded on the running total returned, not
// on each return, so any number of partial returns add up to exactly what was sold - never a paisa more or less.
//
//   given back so far (r of q units) = round(amount x r / q)       for gross, line discount, bill discount share and tax
//   this return                      = given back after - given back before
//   net = gross - discounts, total = net (+ tax when tax was added on top), taxable = net (- tax when it was inside)
//
// The cash rounding on the bill (e.g. to the nearest Rs 5) is shared out the same way, by value returned.

export class ReturnError extends Error {
  constructor(readonly code: "UNKNOWN_LINE" | "INVALID_QUANTITY" | "EXCEEDS_SOLD" | "NOTHING_TO_RETURN", message: string) {
    super(message);
  }
}

/** One line of the invoice being returned against, as it was sold. Quantities are base-unit thousandths. */
export type SoldLine = {
  id: string;
  qtyBase: Milli;
  /** Already returned by earlier returns. */
  returnedBase: Milli;
  grossPaisa: Paisa;
  lineDiscountPaisa: Paisa;
  invoiceDiscountSharePaisa: Paisa;
  taxPaisa: Paisa;
  totalPaisa: Paisa;
  taxIncluded: boolean;
};

export type ReturnRequest = { lineId: string; qtyBase: Milli };

export type ReturnedLine = {
  lineId: string;
  qtyBase: Milli;
  grossPaisa: Paisa;
  lineDiscountPaisa: Paisa;
  invoiceDiscountSharePaisa: Paisa;
  netPaisa: Paisa;
  taxablePaisa: Paisa;
  taxPaisa: Paisa;
  totalPaisa: Paisa;
};

export type PricedReturn = {
  lines: ReturnedLine[];
  grossPaisa: Paisa;
  lineDiscountPaisa: Paisa;
  invoiceDiscountPaisa: Paisa;
  taxablePaisa: Paisa;
  taxPaisa: Paisa;
  roundingPaisa: Paisa;
  totalPaisa: Paisa;
};

const share = (amount: Paisa, returned: Milli, sold: Milli): Paisa => Number(divideRounded(BigInt(amount) * BigInt(returned), BigInt(sold)));

/** The amounts of a line once `returned` thousandths of it have come back. */
function givenBack(line: SoldLine, returned: Milli) {
  const gross = share(line.grossPaisa, returned, line.qtyBase);
  const lineDiscount = share(line.lineDiscountPaisa, returned, line.qtyBase);
  const invoiceShare = share(line.invoiceDiscountSharePaisa, returned, line.qtyBase);
  const tax = share(line.taxPaisa, returned, line.qtyBase);
  const net = gross - lineDiscount - invoiceShare;
  return { gross, lineDiscount, invoiceShare, tax, net, taxable: net - (line.taxIncluded ? tax : 0), total: net + (line.taxIncluded ? 0 : tax) };
}

export function priceReturn(input: { lines: SoldLine[]; roundingPaisa: Paisa; returning: ReturnRequest[] }): PricedReturn {
  const requested = new Map<string, Milli>();
  for (const request of input.returning) {
    if (!Number.isSafeInteger(request.qtyBase) || request.qtyBase <= 0) throw new ReturnError("INVALID_QUANTITY", "A returned quantity must be more than zero");
    if (requested.has(request.lineId)) throw new ReturnError("INVALID_QUANTITY", "A line can be returned only once in one return");
    requested.set(request.lineId, request.qtyBase);
  }
  if (requested.size === 0) throw new ReturnError("NOTHING_TO_RETURN", "Choose what is being returned");
  for (const lineId of requested.keys()) {
    if (!input.lines.some((line) => line.id === lineId)) throw new ReturnError("UNKNOWN_LINE", "A returned line is not on this invoice");
  }

  const lines: ReturnedLine[] = [];
  let valueBefore = 0;
  let valueAfter = 0;
  for (const line of input.lines) {
    const now = requested.get(line.id) ?? 0;
    const after = line.returnedBase + now;
    if (after > line.qtyBase) throw new ReturnError("EXCEEDS_SOLD", "More is being returned than was sold");
    const before = givenBack(line, line.returnedBase);
    const total = givenBack(line, after);
    valueBefore += before.total;
    valueAfter += total.total;
    if (now === 0) continue;
    lines.push({
      lineId: line.id,
      qtyBase: now,
      grossPaisa: total.gross - before.gross,
      lineDiscountPaisa: total.lineDiscount - before.lineDiscount,
      invoiceDiscountSharePaisa: total.invoiceShare - before.invoiceShare,
      netPaisa: total.net - before.net,
      taxablePaisa: total.taxable - before.taxable,
      taxPaisa: total.tax - before.tax,
      totalPaisa: total.total - before.total,
    });
  }

  // The bill's rounding follows the value returned. A bill with nothing in it has no rounding to share.
  const billValue = input.lines.reduce((sum, line) => sum + line.totalPaisa, 0);
  const roundingAt = (valueReturned: Paisa) => (billValue === 0 ? 0 : Number(divideRounded(BigInt(input.roundingPaisa) * BigInt(valueReturned), BigInt(billValue))));
  const roundingPaisa = roundingAt(valueAfter) - roundingAt(valueBefore);

  const sum = (pick: (line: ReturnedLine) => number) => lines.reduce((total, line) => total + pick(line), 0);
  return {
    lines,
    grossPaisa: sum((line) => line.grossPaisa),
    lineDiscountPaisa: sum((line) => line.lineDiscountPaisa),
    invoiceDiscountPaisa: sum((line) => line.invoiceDiscountSharePaisa),
    taxablePaisa: sum((line) => line.taxablePaisa),
    taxPaisa: sum((line) => line.taxPaisa),
    roundingPaisa,
    totalPaisa: sum((line) => line.totalPaisa) + roundingPaisa,
  };
}

/** Whether the bill is older than the shop takes returns for. The window is elapsed time, 24 hours to a day. */
export function isOutsideReturnWindow(postedAt: Date, now: Date, windowDays: number): boolean {
  return now.getTime() - postedAt.getTime() > windowDays * 86_400_000;
}
