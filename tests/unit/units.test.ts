import { describe, expect, it } from "vitest";
import { breakDownQuantity, formatQuantity, parseQuantity, toBaseQuantity } from "../../shared/units";

describe("parseQuantity and formatQuantity", () => {
  it.each([
    ["0", 0, "0"],
    ["1", 1000, "1"],
    ["2.5", 2500, "2.5"],
    ["0.001", 1, "0.001"],
    ["12.340", 12340, "12.34"],
    ["2000", 2000000, "2000"],
  ])("%s", (input, milli, text) => {
    expect(parseQuantity(input)).toBe(milli);
    expect(formatQuantity(milli)).toBe(text);
  });

  it.each(["", "-1", "1.2345", "abc", "1,5", ".5"])("rejects %j", (input) => {
    expect(() => parseQuantity(input)).toThrow(RangeError);
  });

  it("formats negative adjustment quantities", () => {
    expect(formatQuantity(-2500)).toBe("-2.5");
  });
});

describe("toBaseQuantity", () => {
  it("converts 10 cartons of 200 pieces to 2,000 pieces", () => {
    expect(toBaseQuantity(parseQuantity("10"), parseQuantity("200"))).toBe(parseQuantity("2000"));
  });

  it("converts fractional quantities exactly", () => {
    expect(toBaseQuantity(parseQuantity("0.5"), parseQuantity("200"))).toBe(parseQuantity("100"));
    expect(toBaseQuantity(parseQuantity("2.5"), parseQuantity("12"))).toBe(parseQuantity("30"));
  });

  it("treats the base unit (factor 1) as identity", () => {
    expect(toBaseQuantity(7250, 1000)).toBe(7250);
  });

  it("rejects results finer than a thousandth of a base unit", () => {
    expect(() => toBaseQuantity(parseQuantity("0.001"), parseQuantity("0.5"))).toThrow(RangeError);
  });

  it("rejects a zero or negative factor", () => {
    expect(() => toBaseQuantity(1000, 0)).toThrow(RangeError);
    expect(() => toBaseQuantity(1000, -1000)).toThrow(RangeError);
  });

  it("rejects values beyond the safe integer range", () => {
    expect(() => toBaseQuantity(Number.MAX_SAFE_INTEGER, 2000000)).toThrow(RangeError);
  });
});

describe("breakDownQuantity", () => {
  const units = [
    { unitId: "piece", factorToBaseMilli: 1000 },
    { unitId: "carton", factorToBaseMilli: 200000 },
    { unitId: "pack", factorToBaseMilli: 10000 },
  ];

  it("shows 2,050 pieces as 10 cartons and 5 packs", () => {
    expect(breakDownQuantity(parseQuantity("2050"), units)).toEqual([
      { unitId: "carton", quantityMilli: parseQuantity("10") },
      { unitId: "pack", quantityMilli: parseQuantity("5") },
    ]);
  });

  it("keeps a remainder in the base unit", () => {
    expect(breakDownQuantity(parseQuantity("217"), units)).toEqual([
      { unitId: "carton", quantityMilli: parseQuantity("1") },
      { unitId: "pack", quantityMilli: parseQuantity("1") },
      { unitId: "piece", quantityMilli: parseQuantity("7") },
    ]);
  });

  it("returns nothing for zero stock", () => {
    expect(breakDownQuantity(0, units)).toEqual([]);
  });
});
