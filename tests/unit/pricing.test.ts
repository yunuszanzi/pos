import { describe, expect, it } from "vitest";
import {
  allocateProportionally, cashRoundingSteps, discountPercentBps, discountsOverLimit, priceCart, PricingError, roundToCashStep,
  type CashRoundingStep, type Discount, type PricedCart, type PricingInput, type PricingLine,
} from "../../shared/pricing";

const line = (qty: number, unitPricePaisa: number, taxRateBps = 0, discount?: Discount): PricingLine =>
  ({ qtyMilli: qty * 1000, unitPricePaisa, taxRateBps, discount });
const percent = (bps: number): Discount => ({ type: "percent", bps });
const fixed = (paisa: number): Discount => ({ type: "fixed", paisa });
const cart = (input: Partial<PricingInput> & { lines: PricingLine[] }) => priceCart({ taxMode: "exclusive", ...input });

describe("priceCart: tax", () => {
  it("adds tax on top when prices exclude it: 3 x Rs 100 at 18%", () => {
    const priced = cart({ lines: [line(3, 10000, 1800)] });
    expect(priced).toMatchObject({ grossPaisa: 30000, taxPaisa: 5400, taxablePaisa: 30000, totalPaisa: 35400, discountPaisa: 0, roundingPaisa: 0 });
  });

  it("finds the tax inside the price when prices include it: Rs 118 at 18%", () => {
    const priced = cart({ taxMode: "inclusive", lines: [line(1, 11800, 1800)] });
    expect(priced.lines[0]).toMatchObject({ grossPaisa: 11800, taxablePaisa: 10000, taxPaisa: 1800, totalPaisa: 11800 });
    expect(priced.totalPaisa).toBe(11800);
  });

  it("charges no tax at 0% in either mode", () => {
    for (const taxMode of ["inclusive", "exclusive"] as const) {
      const priced = cart({ taxMode, lines: [line(2, 5000, 0)] });
      expect(priced).toMatchObject({ taxPaisa: 0, taxablePaisa: 10000, totalPaisa: 10000 });
    }
  });

  it("rounds each line's tax to the paisa, half away from zero: 18% of Rs 3.33 is 59.94 paisa", () => {
    expect(cart({ lines: [line(1, 333, 1800)] }).lines[0].taxPaisa).toBe(60);
    // 18% of 25 paisa = 4.5 -> 5
    expect(cart({ lines: [line(1, 25, 1800)] }).lines[0].taxPaisa).toBe(5);
  });

  it("applies each line's own rate", () => {
    const priced = cart({ lines: [line(1, 10000, 1800), line(1, 10000, 500), line(1, 10000, 0)] });
    expect(priced.lines.map((entry) => entry.taxPaisa)).toEqual([1800, 500, 0]);
    expect(priced.totalPaisa).toBe(32300);
  });

  it("takes tax out of a discounted inclusive line: Rs 118 less 10%", () => {
    const priced = cart({ taxMode: "inclusive", lines: [line(1, 11800, 1800, percent(1000))] });
    expect(priced.lines[0]).toMatchObject({ lineDiscountPaisa: 1180, netPaisa: 10620, taxablePaisa: 9000, taxPaisa: 1620, totalPaisa: 10620 });
  });
});

describe("priceCart: quantities and discounts", () => {
  it("prices fractional quantities, half away from zero: 2.5 kg at Rs 99.99", () => {
    expect(cart({ lines: [{ qtyMilli: 2500, unitPricePaisa: 9999, taxRateBps: 0 }] }).grossPaisa).toBe(24998);
  });

  it("takes a percentage line discount: 12.5% off Rs 19.99", () => {
    const priced = cart({ lines: [line(1, 1999, 0, percent(1250))] });
    expect(priced.lines[0]).toMatchObject({ lineDiscountPaisa: 250, netPaisa: 1749, totalPaisa: 1749 });
  });

  it("takes a fixed line discount", () => {
    expect(cart({ lines: [line(2, 5000, 0, fixed(1500))] }).totalPaisa).toBe(8500);
  });

  it("shares a 5% bill discount across lines and taxes what is left: Rs 100 + Rs 50 at 18%", () => {
    const priced = cart({ lines: [line(1, 10000, 1800), line(1, 5000, 1800)], invoiceDiscount: percent(500) });
    expect(priced.invoiceDiscountPaisa).toBe(750);
    expect(priced.lines.map((entry) => entry.invoiceDiscountSharePaisa)).toEqual([500, 250]);
    expect(priced.lines.map((entry) => [entry.netPaisa, entry.taxPaisa, entry.totalPaisa])).toEqual([[9500, 1710, 11210], [4750, 855, 5605]]);
    expect(priced).toMatchObject({ grossPaisa: 15000, discountPaisa: 750, taxPaisa: 2565, totalPaisa: 16815 });
  });

  it("takes the bill discount after the line discounts", () => {
    const priced = cart({ lines: [line(1, 10000, 0, percent(1000)), line(1, 10000)], invoiceDiscount: percent(1000) });
    // lines after their own discounts: 9000 + 10000 = 19000; 10% of that is 1900
    expect(priced.invoiceDiscountPaisa).toBe(1900);
    expect(priced.discountPaisa).toBe(2900);
    expect(priced.totalPaisa).toBe(17100);
  });

  it("allows a 100% discount and a free line", () => {
    expect(cart({ lines: [line(1, 10000, 1800)], invoiceDiscount: percent(10000) })).toMatchObject({ totalPaisa: 0, taxPaisa: 0 });
    expect(cart({ lines: [line(1, 0, 1800), line(1, 100, 1800)] }).totalPaisa).toBe(118);
  });

  it("keeps a fully discounted line out of the bill discount", () => {
    const priced = cart({ lines: [line(1, 10000, 0, percent(10000)), line(1, 5000)], invoiceDiscount: fixed(1000) });
    expect(priced.lines.map((entry) => entry.invoiceDiscountSharePaisa)).toEqual([0, 1000]);
  });
});

describe("allocateProportionally", () => {
  it("gives leftover paisa to the largest remainders, the earlier line winning a tie", () => {
    expect(allocateProportionally(100, [10000, 10000, 10000])).toEqual([34, 33, 33]);
  });

  it("follows the weights", () => {
    expect(allocateProportionally(10, [1, 2, 7])).toEqual([1, 2, 7]);
    // 10 x 1/3 = 3.33, 10 x 2/3 = 6.67 -> floors 3 and 6, the leftover paisa goes to the larger remainder
    expect(allocateProportionally(10, [1, 2])).toEqual([3, 7]);
  });

  it("returns zeros for nothing to share, and refuses to share across nothing", () => {
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
    expect(() => allocateProportionally(1, [0, 0])).toThrow(PricingError);
  });

  it("always adds up exactly", () => {
    for (const [total, weights] of [[1, [1, 1, 1]], [999, [3, 5, 7, 11]], [12345, [100, 1, 1]], [7, [2, 2, 2, 2, 2]]] as const) {
      expect(allocateProportionally(total, [...weights]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe("cash rounding", () => {
  it.each([
    [35437, 100, 35400, -37],
    [35450, 100, 35500, 50],
    [35437, 500, 35500, 63],
    [35437, 1000, 35000, -437],
    [35437, 0, 35437, 0],
    [0, 500, 0, 0],
  ] as const)("%i to the nearest %i paisa is %i", (total, step, rounded, rounding) => {
    expect(roundToCashStep(total, step as CashRoundingStep)).toEqual({ totalPaisa: rounded, roundingPaisa: rounding });
  });

  it("shows the rounding as its own line on the bill", () => {
    const priced = cart({ lines: [line(3, 11813, 1800)], cashRounding: 500 });
    expect(priced.beforeRoundingPaisa).toBe(41818);
    // 3 x Rs 118.13 = 35439 + 18% tax (6379) = 41818, which is closer to 42000 than to 41500
    expect(priced).toMatchObject({ roundingPaisa: 182, totalPaisa: 42000 });
    expect(priced.totalPaisa - priced.beforeRoundingPaisa).toBe(priced.roundingPaisa);
  });
});

describe("priceCart: invalid input", () => {
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error instanceof PricingError ? error.code : "other";
    }
    return "no error";
  };

  it("rejects discounts that are not possible", () => {
    expect(code(() => cart({ lines: [line(1, 1000, 0, fixed(1001))] }))).toBe("DISCOUNT_EXCEEDS_VALUE");
    expect(code(() => cart({ lines: [line(1, 1000)], invoiceDiscount: fixed(1001) }))).toBe("DISCOUNT_EXCEEDS_VALUE");
    expect(code(() => cart({ lines: [line(1, 1000, 0, percent(10100))] }))).toBe("INVALID_DISCOUNT");
    expect(code(() => cart({ lines: [line(1, 1000, 0, percent(-1))] }))).toBe("INVALID_DISCOUNT");
    expect(code(() => cart({ lines: [line(1, 1000, 0, fixed(-5))] }))).toBe("INVALID_DISCOUNT");
    expect(code(() => cart({ lines: [line(1, 1000, 0, fixed(1.5))] }))).toBe("INVALID_DISCOUNT");
  });

  it("rejects an empty cart and bad lines", () => {
    expect(code(() => cart({ lines: [] }))).toBe("EMPTY_CART");
    expect(code(() => cart({ lines: [{ qtyMilli: 0, unitPricePaisa: 100, taxRateBps: 0 }] }))).toBe("INVALID_LINE");
    expect(code(() => cart({ lines: [{ qtyMilli: 1000, unitPricePaisa: -1, taxRateBps: 0 }] }))).toBe("INVALID_LINE");
    expect(code(() => cart({ lines: [{ qtyMilli: 1000, unitPricePaisa: 100, taxRateBps: 10001 }] }))).toBe("INVALID_LINE");
    expect(code(() => cart({ lines: [{ qtyMilli: 1.5, unitPricePaisa: 100, taxRateBps: 0 }] }))).toBe("INVALID_LINE");
  });

  it("refuses amounts too large to calculate exactly instead of rounding them silently", () => {
    expect(code(() => cart({ lines: [{ qtyMilli: 99_999_999_999, unitPricePaisa: 100_000_000_000, taxRateBps: 0 }] }))).toBe("INVALID_LINE");
  });
});

describe("discount limits (FR-SAL-04)", () => {
  it("turns a fixed discount into a percentage, rounded up", () => {
    expect(discountPercentBps(fixed(500), 10000)).toBe(500);
    expect(discountPercentBps(fixed(501), 10000)).toBe(501);
    expect(discountPercentBps(fixed(1), 3)).toBe(3334);
    expect(discountPercentBps(percent(750), 12345)).toBe(750);
    expect(discountPercentBps(fixed(0), 0)).toBe(0);
    expect(() => discountPercentBps(fixed(5), 0)).toThrow(PricingError);
  });

  it("lists the discounts over a role's limit", () => {
    const input: PricingInput = {
      taxMode: "exclusive",
      lines: [line(1, 10000, 0, percent(600)), line(1, 10000, 0, percent(500)), line(1, 10000)],
      invoiceDiscount: fixed(1501),
    };
    const priced = priceCart(input);
    // the bill discount is taken from 9400 + 9500 + 10000 = 28900 after line discounts; 1501 / 28900 = 5.19% -> 520 bps
    expect(discountsOverLimit(input, priced, 500)).toEqual([{ scope: "line", lineIndex: 0, bps: 600 }, { scope: "invoice", bps: 520 }]);
    expect(discountsOverLimit(input, priced, 10000)).toEqual([]);
    expect(discountsOverLimit({ taxMode: "exclusive", lines: [line(1, 10000)] }, priceCart({ taxMode: "exclusive", lines: [line(1, 10000)] }), 0)).toEqual([]);
  });
});

// A seeded generator, so a failure can be reproduced from its seed.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("priceCart: invariants hold for thousands of random carts", () => {
  it("never loses or invents a paisa", () => {
    const random = mulberry32(20261103);
    const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
    const rates = [0, 500, 1000, 1800, 2500];
    const runs = 4000;
    let skipped = 0;
    for (let run = 0; run < runs; run += 1) {
      const lines: PricingLine[] = Array.from({ length: int(1, 8) }, () => {
        const qtyMilli = int(1, 50_000);
        const unitPricePaisa = int(0, 2_000_000);
        const gross = Math.round((qtyMilli * unitPricePaisa) / 1000);
        const kind = int(0, 2);
        const discount: Discount | undefined = kind === 0 ? undefined : kind === 1 ? percent(int(0, 400) * 25) : fixed(int(0, gross));
        return { qtyMilli, unitPricePaisa, taxRateBps: rates[int(0, rates.length - 1)], discount };
      });
      const afterLine = lines.reduce((total, entry) => {
        const gross = Math.round((entry.qtyMilli * entry.unitPricePaisa) / 1000);
        return total + gross - (entry.discount ? (entry.discount.type === "fixed" ? entry.discount.paisa : Math.round((gross * entry.discount.bps) / 10000)) : 0);
      }, 0);
      const invoiceDiscount: Discount | undefined = int(0, 2) === 0 ? undefined : int(0, 1) === 0 ? percent(int(0, 400) * 25) : fixed(int(0, Math.max(0, afterLine)));
      const taxMode = int(0, 1) === 0 ? "inclusive" : "exclusive";
      const cashRounding = cashRoundingSteps[int(0, cashRoundingSteps.length - 1)];
      const input: PricingInput = { lines, invoiceDiscount, taxMode, cashRounding };

      let priced: PricedCart;
      try {
        priced = priceCart(input);
      } catch (error) {
        // The reference arithmetic above can differ from the engine by a paisa when a generated fixed discount lands on the edge.
        if (error instanceof PricingError && error.code === "DISCOUNT_EXCEEDS_VALUE") {
          skipped += 1;
          continue;
        }
        throw error;
      }
      const context = `run ${run} ${JSON.stringify(input)}`;
      const total = (pick: (entry: (typeof priced.lines)[number]) => number) => priced.lines.reduce((sum, entry) => sum + pick(entry), 0);

      expect(total((entry) => entry.invoiceDiscountSharePaisa), context).toBe(priced.invoiceDiscountPaisa);
      expect(total((entry) => entry.totalPaisa), context).toBe(priced.beforeRoundingPaisa);
      expect(total((entry) => entry.grossPaisa), context).toBe(priced.grossPaisa);
      expect(priced.grossPaisa - priced.discountPaisa, context).toBe(total((entry) => entry.netPaisa));
      expect(total((entry) => entry.taxPaisa), context).toBe(priced.taxPaisa);
      expect(priced.totalPaisa, context).toBe(priced.beforeRoundingPaisa + priced.roundingPaisa);
      for (const entry of priced.lines) {
        expect(entry.netPaisa, context).toBeGreaterThanOrEqual(0);
        expect(entry.taxPaisa, context).toBeGreaterThanOrEqual(0);
        expect(entry.invoiceDiscountSharePaisa, context).toBeLessThanOrEqual(entry.grossPaisa - entry.lineDiscountPaisa);
        if (taxMode === "exclusive") {
          expect(entry.taxablePaisa, context).toBe(entry.netPaisa);
          expect(entry.totalPaisa, context).toBe(entry.netPaisa + entry.taxPaisa);
        } else {
          expect(entry.totalPaisa, context).toBe(entry.netPaisa);
          expect(entry.taxablePaisa + entry.taxPaisa, context).toBe(entry.netPaisa);
        }
      }
      if (cashRounding) {
        expect(priced.totalPaisa % cashRounding, context).toBe(0);
        expect(Math.abs(priced.roundingPaisa), context).toBeLessThanOrEqual(cashRounding / 2);
      } else {
        expect(priced.roundingPaisa, context).toBe(0);
      }
      expect(priceCart(input), context).toEqual(priced);
    }
    // The skip above is only for generator edge cases; if it were common the test would be checking little.
    expect(skipped).toBeLessThan(runs / 50);
  });
});
