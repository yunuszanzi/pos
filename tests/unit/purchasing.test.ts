import { describe, expect, it } from "vitest";
import { averageAfterReceipt, costPerBaseUnit, orderTotal, purchaseLineValue, remainingToReceive, statusAfterReceipt, suggestReorder, unitCostFromBase } from "../../shared/purchasing";

describe("purchase line value and cost per base unit", () => {
  it("values a line as quantity times the price of the unit it was bought in", () => {
    expect(purchaseLineValue(10_000, 320_000)).toBe(3_200_000); // 10 cartons at Rs 3,200.00
    expect(purchaseLineValue(2_500, 1_000)).toBe(2_500); //        2.5 kg at Rs 10.00
    expect(purchaseLineValue(333, 100)).toBe(33); //                0.333 at Rs 1.00 rounds to the paisa
  });

  it("works out the cost of one piece from the price of a carton, to the paisa", () => {
    expect(costPerBaseUnit(320_000, 200_000)).toBe(1_600); // Rs 3,200 per carton of 200
    expect(costPerBaseUnit(100_000, 3_000)).toBe(33_333); //  Rs 1,000 for 3 pieces: 333.33 each
    expect(costPerBaseUnit(1_000, 1_000)).toBe(1_000); //     a piece bought as a piece
    expect(() => costPerBaseUnit(100, 0)).toThrow();
  });
});

describe("weighted average cost", () => {
  it("blends what is held with what comes in", () => {
    // 100 pieces held at Rs 10.00, 100 more arrive at Rs 12.00: Rs 11.00.
    expect(averageAfterReceipt({ onHandMilli: 100_000, averagePaisa: 1_000, receivedMilli: 100_000, costPaisa: 1_200 })).toBe(1_100);
    // 300 at Rs 10.00 and 100 at Rs 14.00: (300 x 1000 + 100 x 1400) / 400 = 1100.
    expect(averageAfterReceipt({ onHandMilli: 300_000, averagePaisa: 1_000, receivedMilli: 100_000, costPaisa: 1_400 })).toBe(1_100);
  });

  it("rounds to the whole paisa, half away from zero", () => {
    // (1 x 100 + 2 x 101) / 3 = 100.67 -> 101; (1 x 100 + 1 x 101) / 2 = 100.5 -> 101.
    expect(averageAfterReceipt({ onHandMilli: 1_000, averagePaisa: 100, receivedMilli: 2_000, costPaisa: 101 })).toBe(101);
    expect(averageAfterReceipt({ onHandMilli: 1_000, averagePaisa: 100, receivedMilli: 1_000, costPaisa: 101 })).toBe(101);
  });

  it("works with fractional quantities", () => {
    expect(averageAfterReceipt({ onHandMilli: 2_500, averagePaisa: 1_000, receivedMilli: 2_500, costPaisa: 2_000 })).toBe(1_500);
  });

  it("starts afresh from the incoming cost when nothing, or less than nothing, is held", () => {
    expect(averageAfterReceipt({ onHandMilli: 0, averagePaisa: 999, receivedMilli: 5_000, costPaisa: 1_500 })).toBe(1_500);
    expect(averageAfterReceipt({ onHandMilli: -3_000, averagePaisa: 999, receivedMilli: 5_000, costPaisa: 1_500 })).toBe(1_500);
  });

  it("keeps the average when nothing comes in", () => {
    expect(averageAfterReceipt({ onHandMilli: 5_000, averagePaisa: 777, receivedMilli: 0, costPaisa: 1 })).toBe(777);
  });
});

describe("receiving against an order", () => {
  it("tracks what is left on a line", () => {
    expect(remainingToReceive({ qtyBase: 100_000, receivedBase: 60_000 })).toBe(40_000);
    expect(remainingToReceive({ qtyBase: 100_000, receivedBase: 100_000 })).toBe(0);
  });

  it("acceptance 1: 60 then 40 of 100 takes the order from sent to partly received to received", () => {
    expect(statusAfterReceipt([{ qtyBase: 100_000, receivedBase: 0 }])).toBe("sent");
    expect(statusAfterReceipt([{ qtyBase: 100_000, receivedBase: 60_000 }])).toBe("partly_received");
    expect(statusAfterReceipt([{ qtyBase: 100_000, receivedBase: 100_000 }])).toBe("received");
  });

  it("is received only when every line is complete", () => {
    expect(statusAfterReceipt([{ qtyBase: 10_000, receivedBase: 10_000 }, { qtyBase: 5_000, receivedBase: 4_000 }])).toBe("partly_received");
    expect(statusAfterReceipt([{ qtyBase: 10_000, receivedBase: 10_000 }, { qtyBase: 5_000, receivedBase: 5_000 }])).toBe("received");
  });

  it("adds up an order", () => {
    expect(orderTotal([{ valuePaisa: 3_200_000 }, { valuePaisa: 25_050 }])).toBe(3_225_050);
    expect(orderTotal([])).toBe(0);
  });
});

describe("suggesting the price of a bought unit", () => {
  it("is the cost of one piece times the pieces in the unit", () => {
    expect(unitCostFromBase(1_600, 200_000)).toBe(320_000);
    expect(unitCostFromBase(333, 10_000)).toBe(3_330);
    expect(unitCostFromBase(1_001, 500)).toBe(501); // half a piece in the unit: 500.5 rounds up
  });
});

describe("what to reorder", () => {
  const base = { onHandMilli: 0, onOrderMilli: 0, levelMilli: 50_000, reorderQuantityMilli: 0 };

  it("suggests nothing for stock above its level, or for an item with no level", () => {
    expect(suggestReorder({ ...base, onHandMilli: 51_000 })).toBeNull();
    expect(suggestReorder({ ...base, onHandMilli: 0, levelMilli: 0 })).toBeNull();
  });

  it("suggests the SKU's reorder quantity when stock is at or below its level", () => {
    expect(suggestReorder({ ...base, onHandMilli: 50_000, reorderQuantityMilli: 200_000 })).toBe(200_000);
    expect(suggestReorder({ ...base, onHandMilli: 10_000, reorderQuantityMilli: 200_000 })).toBe(200_000);
  });

  it("suggests getting back up to the level when there is no reorder quantity", () => {
    expect(suggestReorder({ ...base, onHandMilli: 20_000 })).toBe(30_000);
    expect(suggestReorder({ ...base, onHandMilli: 50_000 })).toBe(1); // at the level: the smallest quantity there is
  });

  it("counts what is already on order, so an order on its way is not suggested again", () => {
    expect(suggestReorder({ ...base, onHandMilli: 10_000, onOrderMilli: 100_000 })).toBeNull();
    expect(suggestReorder({ ...base, onHandMilli: 10_000, onOrderMilli: 20_000, reorderQuantityMilli: 200_000 })).toBe(200_000);
    expect(suggestReorder({ ...base, onHandMilli: 10_000, onOrderMilli: 20_000 })).toBe(20_000);
  });

  it("treats overselling as stock of nothing it can lean on: negative stock asks for more", () => {
    expect(suggestReorder({ ...base, onHandMilli: -5_000 })).toBe(55_000);
  });
});
