import { describe, expect, it } from "vitest";
import { applyEntry, positionKey, replayStockLedger } from "../../shared/stockLedger";
import { parseQuantity } from "../../shared/units";

const q = parseQuantity;

describe("applyEntry", () => {
  it("starts the average at the first receipt's cost", () => {
    expect(applyEntry({ onHandMilli: 0, avgCostPaisa: 0 }, q("100"), 1000)).toEqual({ onHandMilli: q("100"), avgCostPaisa: 1000 });
  });

  it("recalculates the weighted average on a receipt: (100 x 1000 + 50 x 1600) / 150 = 1200", () => {
    expect(applyEntry({ onHandMilli: q("100"), avgCostPaisa: 1000 }, q("50"), 1600)).toEqual({ onHandMilli: q("150"), avgCostPaisa: 1200 });
  });

  it("keeps the average on an issue", () => {
    expect(applyEntry({ onHandMilli: q("150"), avgCostPaisa: 1200 }, -q("20"), 1200)).toEqual({ onHandMilli: q("130"), avgCostPaisa: 1200 });
  });

  it("rounds half away from zero like the database", () => {
    // (1 x 100 + 1 x 101) / 2 = 100.5 -> 101
    expect(applyEntry({ onHandMilli: q("1"), avgCostPaisa: 100 }, q("1"), 101).avgCostPaisa).toBe(101);
    // (2 x 100 + 1 x 101) / 3 = 100.33 -> 100
    expect(applyEntry({ onHandMilli: q("2"), avgCostPaisa: 100 }, q("1"), 101).avgCostPaisa).toBe(100);
  });

  it("handles fractional quantities exactly", () => {
    // (0.5 x 1000 + 0.25 x 2000) / 0.75 = 1333.33 -> 1333
    expect(applyEntry({ onHandMilli: q("0.5"), avgCostPaisa: 1000 }, q("0.25"), 2000).avgCostPaisa).toBe(1333);
  });

  it("ignores negative stock when costing a receipt", () => {
    expect(applyEntry({ onHandMilli: -q("5"), avgCostPaisa: 900 }, q("10"), 1000)).toEqual({ onHandMilli: q("5"), avgCostPaisa: 1000 });
  });

  it("leaves the average alone while a receipt still leaves stock at or below zero", () => {
    expect(applyEntry({ onHandMilli: -q("10"), avgCostPaisa: 900 }, q("4"), 1000)).toEqual({ onHandMilli: -q("6"), avgCostPaisa: 900 });
  });

  it("does not overflow on large quantities and costs", () => {
    const big = applyEntry({ onHandMilli: q("99999999"), avgCostPaisa: 99_999_999 }, q("1"), 99_999_999);
    expect(big.avgCostPaisa).toBe(99_999_999);
  });
});

describe("replayStockLedger", () => {
  it("keeps a separate position per variant and location", () => {
    const positions = replayStockLedger([
      { variantId: "v1", locationId: "a", qtyMilli: q("10"), unitCostPaisa: 100 },
      { variantId: "v1", locationId: "b", qtyMilli: q("5"), unitCostPaisa: 200 },
      { variantId: "v2", locationId: "a", qtyMilli: q("1"), unitCostPaisa: 50 },
      { variantId: "v1", locationId: "a", qtyMilli: -q("4"), unitCostPaisa: 100 },
    ]);
    expect(positions.get(positionKey("v1", "a"))).toEqual({ onHandMilli: q("6"), avgCostPaisa: 100 });
    expect(positions.get(positionKey("v1", "b"))).toEqual({ onHandMilli: q("5"), avgCostPaisa: 200 });
    expect(positions.get(positionKey("v2", "a"))).toEqual({ onHandMilli: q("1"), avgCostPaisa: 50 });
  });

  it("returns nothing for an empty ledger", () => {
    expect(replayStockLedger([]).size).toBe(0);
  });
});
