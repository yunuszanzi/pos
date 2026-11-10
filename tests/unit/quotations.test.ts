import { describe, expect, it } from "vitest";
import { priceConversion, type QuotedLine } from "../../shared/quotations";

const lines: QuotedLine[] = [
  { id: "a", quantity: "10", unitPricePaisa: 500, lineDiscountPaisa: 500, taxRateBps: 1800 }, // 10 x 5.00 = 50.00, 10% off
  { id: "b", quantity: "4", unitPricePaisa: 2_500, lineDiscountPaisa: 0, taxRateBps: 0 },
];

describe("converting a quotation keeps the quoted prices", () => {
  it("taking everything gives the quotation's own total, to the paisa", () => {
    const all = priceConversion({ taxMode: "exclusive", lines, invoiceDiscountPaisa: 0, picks: [{ quotationLineId: "a", quantityMilli: 10_000 }, { quotationLineId: "b", quantityMilli: 4_000 }] });
    // line a: 5000 - 500 = 4500 + tax 810 = 5310; line b: 10000.
    expect(all.lines.map((line) => line.totalPaisa)).toEqual([5_310, 10_000]);
    expect(all.totalPaisa).toBe(15_310);
    expect(all.lineDiscountPaisa).toBe(500);
  });

  it("taking part of a line scales its discount and keeps the unit price", () => {
    const part = priceConversion({ taxMode: "exclusive", lines, invoiceDiscountPaisa: 0, picks: [{ quotationLineId: "a", quantityMilli: 4_000 }] });
    // 4 x 5.00 = 20.00, discount 10% = 2.00, tax 18% of 18.00 = 3.24.
    expect(part.grossPaisa).toBe(2_000);
    expect(part.lineDiscountPaisa).toBe(200);
    expect(part.taxPaisa).toBe(324);
    expect(part.totalPaisa).toBe(2_124);
  });

  it("shares the whole-quote discount out by the value taken", () => {
    const all = priceConversion({ taxMode: "exclusive", lines, invoiceDiscountPaisa: 1_000, picks: [{ quotationLineId: "a", quantityMilli: 10_000 }, { quotationLineId: "b", quantityMilli: 4_000 }] });
    expect(all.invoiceDiscountPaisa).toBe(1_000);
    const half = priceConversion({ taxMode: "exclusive", lines, invoiceDiscountPaisa: 1_000, picks: [{ quotationLineId: "b", quantityMilli: 4_000 }] });
    // b is 10000 of the quoted 14500 after line discounts: 1000 x 10000 / 14500 = 689.66 -> 690.
    expect(half.invoiceDiscountPaisa).toBe(690);
  });
});
