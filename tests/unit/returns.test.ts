import { describe, expect, it } from "vitest";
import { isOutsideReturnWindow, priceReturn, ReturnError, type SoldLine } from "../../shared/returns";
import { priceCart } from "../../shared/pricing";

// 10 cartons at Rs 1,234.57, a Rs 100.00 line discount, a Rs 333.33 share of a bill discount, 18% tax on top.
function cartons(): SoldLine {
  const priced = priceCart({
    taxMode: "exclusive",
    lines: [{ qtyMilli: 10_000, unitPricePaisa: 123_457, taxRateBps: 1800, discount: { type: "fixed", paisa: 10_000 } }],
    invoiceDiscount: { type: "fixed", paisa: 33_333 },
  }).lines[0];
  return {
    id: "L1", qtyBase: 10_000, returnedBase: 0, grossPaisa: priced.grossPaisa, lineDiscountPaisa: priced.lineDiscountPaisa,
    invoiceDiscountSharePaisa: priced.invoiceDiscountSharePaisa, taxPaisa: priced.taxPaisa, totalPaisa: priced.totalPaisa, taxIncluded: false,
  };
}

describe("a partial return", () => {
  it("gives back the same share of price, discounts and tax (acceptance 2: 3 of 10 cartons)", () => {
    const line = cartons();
    const back = priceReturn({ lines: [line], roundingPaisa: 0, returning: [{ lineId: "L1", qtyBase: 3_000 }] });
    expect(back.lines).toHaveLength(1);
    const [row] = back.lines;
    expect(row.grossPaisa).toBe(Math.round(line.grossPaisa * 0.3));
    expect(row.lineDiscountPaisa).toBe(3_000);
    expect(row.invoiceDiscountSharePaisa).toBe(Math.round(line.invoiceDiscountSharePaisa * 0.3));
    expect(row.taxPaisa).toBe(Math.round(line.taxPaisa * 0.3));
    expect(row.netPaisa).toBe(row.grossPaisa - row.lineDiscountPaisa - row.invoiceDiscountSharePaisa);
    expect(row.totalPaisa).toBe(row.netPaisa + row.taxPaisa);
    expect(back.totalPaisa).toBe(row.totalPaisa);
  });

  it("adds up to exactly what was sold, whatever the order and size of the returns", () => {
    const sold = cartons();
    let line = sold;
    let total = 0;
    let tax = 0;
    for (const qty of [1_000, 2_500, 3_333, 3_167]) {
      const back = priceReturn({ lines: [line], roundingPaisa: 0, returning: [{ lineId: "L1", qtyBase: qty }] });
      total += back.totalPaisa;
      tax += back.taxPaisa;
      line = { ...line, returnedBase: line.returnedBase + qty };
    }
    expect(line.returnedBase).toBe(10_000);
    expect(total).toBe(sold.totalPaisa);
    expect(tax).toBe(sold.taxPaisa);
  });

  it("keeps the tax-included arithmetic: taxable is net less the tax inside it", () => {
    const priced = priceCart({ taxMode: "inclusive", lines: [{ qtyMilli: 7_000, unitPricePaisa: 9_999, taxRateBps: 1800 }] }).lines[0];
    const line: SoldLine = { id: "A", qtyBase: 7_000, returnedBase: 0, grossPaisa: priced.grossPaisa, lineDiscountPaisa: 0, invoiceDiscountSharePaisa: 0, taxPaisa: priced.taxPaisa, totalPaisa: priced.totalPaisa, taxIncluded: true };
    const back = priceReturn({ lines: [line], roundingPaisa: 0, returning: [{ lineId: "A", qtyBase: 2_000 }] }).lines[0];
    expect(back.totalPaisa).toBe(back.netPaisa);
    expect(back.taxablePaisa).toBe(back.netPaisa - back.taxPaisa);
  });

  it("shares the bill's cash rounding by value, and returns all of it with the last item", () => {
    const a: SoldLine = { id: "A", qtyBase: 1_000, returnedBase: 0, grossPaisa: 10_030, lineDiscountPaisa: 0, invoiceDiscountSharePaisa: 0, taxPaisa: 0, totalPaisa: 10_030, taxIncluded: true };
    const b: SoldLine = { id: "B", qtyBase: 1_000, returnedBase: 0, grossPaisa: 5_020, lineDiscountPaisa: 0, invoiceDiscountSharePaisa: 0, taxPaisa: 0, totalPaisa: 5_020, taxIncluded: true };
    // The bill was Rs 150.50, rounded to Rs 150.00: rounding of -50 paisa.
    const first = priceReturn({ lines: [a, b], roundingPaisa: -50, returning: [{ lineId: "A", qtyBase: 1_000 }] });
    const second = priceReturn({ lines: [{ ...a, returnedBase: 1_000 }, b], roundingPaisa: -50, returning: [{ lineId: "B", qtyBase: 1_000 }] });
    expect(first.roundingPaisa + second.roundingPaisa).toBe(-50);
    expect(first.totalPaisa + second.totalPaisa).toBe(15_050 - 50);
  });

  it("refuses more than was sold, an unknown line, a zero quantity, a repeated line, and an empty return", () => {
    const line = { ...cartons(), returnedBase: 8_000 };
    const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as ReturnError).code; } return "none"; };
    expect(code(() => priceReturn({ lines: [line], roundingPaisa: 0, returning: [{ lineId: "L1", qtyBase: 2_001 }] }))).toBe("EXCEEDS_SOLD");
    expect(code(() => priceReturn({ lines: [line], roundingPaisa: 0, returning: [{ lineId: "X", qtyBase: 1 }] }))).toBe("UNKNOWN_LINE");
    expect(code(() => priceReturn({ lines: [line], roundingPaisa: 0, returning: [{ lineId: "L1", qtyBase: 0 }] }))).toBe("INVALID_QUANTITY");
    expect(code(() => priceReturn({ lines: [line], roundingPaisa: 0, returning: [{ lineId: "L1", qtyBase: 1 }, { lineId: "L1", qtyBase: 1 }] }))).toBe("INVALID_QUANTITY");
    expect(code(() => priceReturn({ lines: [line], roundingPaisa: 0, returning: [] }))).toBe("NOTHING_TO_RETURN");
  });
});

describe("the return window", () => {
  it("counts elapsed days from the sale", () => {
    const sold = new Date("2026-11-01T10:00:00Z");
    expect(isOutsideReturnWindow(sold, new Date("2026-11-15T10:00:00Z"), 14)).toBe(false);
    expect(isOutsideReturnWindow(sold, new Date("2026-11-15T10:00:01Z"), 14)).toBe(true);
  });
});
