import { describe, expect, it } from "vitest";
import { absorbedByStock, allocateByValue, billTotals, inputTaxOf, landedCostPerBase } from "../../shared/purchaseBills";

describe("allocating freight across bill lines", () => {
  it("splits by value and always adds up exactly", () => {
    expect(allocateByValue(1_000, [30_000, 10_000])).toEqual([750, 250]);
    expect(allocateByValue(100, [1, 1, 1])).toEqual([34, 33, 33]); // the odd paisa goes to the earliest line
    expect(allocateByValue(100, [1, 2, 3])).toEqual([17, 33, 50]); // 16.67, 33.33, 50: the largest fraction takes the spare paisa
  });

  it("splits evenly when there is no value to go by", () => {
    expect(allocateByValue(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });

  it("handles nothing to split, nothing to split it over, and one line", () => {
    expect(allocateByValue(0, [5, 5])).toEqual([0, 0]);
    expect(allocateByValue(500, [123])).toEqual([500]);
    expect(allocateByValue(500, [])).toEqual([]);
    expect(() => allocateByValue(-1, [1])).toThrow();
  });

  it("adds up to the total for any split", () => {
    for (let total = 0; total < 200; total += 7) {
      for (const values of [[1, 2, 3], [999, 1, 1, 1], [7, 7, 7, 7, 7], [0, 5, 0], [123_456, 789, 42]]) {
        const shares = allocateByValue(total, values);
        expect(shares.reduce((sum, share) => sum + share, 0)).toBe(total);
        expect(shares.every((share) => share >= 0)).toBe(true);
      }
    }
  });
});

describe("input tax and bill totals", () => {
  it("takes the rate in basis points, to the paisa", () => {
    expect(inputTaxOf(100_000, 1_800)).toBe(18_000);
    expect(inputTaxOf(333, 1_800)).toBe(60); // 59.94
    expect(inputTaxOf(100_000, 0)).toBe(0);
  });

  it("adds items, tax and charges", () => {
    expect(billTotals([{ valuePaisa: 640_000, taxPaisa: 115_200 }, { valuePaisa: 31_250, taxPaisa: 5_625 }], [10_000, 2_500])).toEqual({
      subtotalPaisa: 671_250, taxPaisa: 120_825, chargesPaisa: 12_500, totalPaisa: 804_575,
    });
  });
});

describe("what a bill does to the cost of stock", () => {
  it("shows the cost per piece with freight in it", () => {
    // 2 cartons of 200 at Rs 3,200.00 plus Rs 400.00 of freight: Rs 6,800.00 over 400 pieces = Rs 17.00.
    expect(landedCostPerBase({ valuePaisa: 640_000, chargeSharePaisa: 40_000, qtyBaseMilli: 400_000 })).toBe(1_700);
    expect(() => landedCostPerBase({ valuePaisa: 1, chargeSharePaisa: 0, qtyBaseMilli: 0 })).toThrow();
  });

  it("adds the difference to the stock still on hand", () => {
    // Received at Rs 16.00 a piece (400 pieces = Rs 6,400.00); the bill says Rs 6,800.00 with freight: +Rs 400.00, all on hand.
    const bill = { valuePaisa: 640_000, chargeSharePaisa: 40_000, qtyBaseMilli: 400_000, receiptCostPerBasePaisa: 1_600 };
    expect(absorbedByStock({ ...bill, onHandMilli: 400_000 })).toBe(40_000);
    // Only a quarter is left (100 of 400): a quarter of the difference can be carried.
    expect(absorbedByStock({ ...bill, onHandMilli: 100_000 })).toBe(10_000);
    // More on hand than was billed: the whole difference.
    expect(absorbedByStock({ ...bill, onHandMilli: 900_000 })).toBe(40_000);
  });

  it("can be negative when the bill is cheaper than the receipt, and zero when nothing differs or nothing is held", () => {
    const bill = { chargeSharePaisa: 0, qtyBaseMilli: 400_000, receiptCostPerBasePaisa: 1_600, onHandMilli: 400_000 };
    expect(absorbedByStock({ ...bill, valuePaisa: 600_000 })).toBe(-40_000);
    expect(absorbedByStock({ ...bill, valuePaisa: 640_000 })).toBe(0);
    expect(absorbedByStock({ ...bill, valuePaisa: 700_000, onHandMilli: 0 })).toBe(0);
    expect(absorbedByStock({ ...bill, valuePaisa: 700_000, onHandMilli: -5_000 })).toBe(0);
  });
});
