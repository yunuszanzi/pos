import { describe, expect, it } from "vitest";
import { breakDownQuantity, formatQuantity, parseQuantity, parseSignedQuantity, sanitiseQuantityText, toBaseQuantity } from "../../shared/units";

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

describe("parseSignedQuantity", () => {
  it("parses movements out of stock", () => {
    expect(parseSignedQuantity("-30.000")).toBe(-30000);
    expect(parseSignedQuantity("12.5")).toBe(12500);
    expect(parseSignedQuantity("0.000")).toBe(0);
  });

  it("rejects what parseQuantity rejects", () => {
    expect(() => parseSignedQuantity("--1")).toThrow(RangeError);
    expect(() => parseSignedQuantity("abc")).toThrow(RangeError);
    expect(() => parseSignedQuantity("-")).toThrow(RangeError);
  });
});

describe("sanitiseQuantityText", () => {
  it("drops letters, signs, spaces and commas", () => {
    expect(sanitiseQuantityText("abc")).toBe("");
    expect(sanitiseQuantityText("12ab3")).toBe("123");
    expect(sanitiseQuantityText("-5")).toBe("5");
    expect(sanitiseQuantityText(" 1 000,5 ")).toBe("10005");
    expect(sanitiseQuantityText("1e3")).toBe("13");
  });

  it("keeps one decimal point and at most three places", () => {
    expect(sanitiseQuantityText("2.5")).toBe("2.5");
    expect(sanitiseQuantityText("2.")).toBe("2.");
    expect(sanitiseQuantityText(".5")).toBe(".5");
    expect(sanitiseQuantityText("1.2.3")).toBe("1.23");
    expect(sanitiseQuantityText("1.23456")).toBe("1.234");
  });

  it("takes whole numbers only when no decimals are allowed", () => {
    expect(sanitiseQuantityText("12.5", 0)).toBe("125");
    expect(sanitiseQuantityText("3", 0)).toBe("3");
  });

  it("stops at the 11 whole digits a quantity can hold", () => {
    expect(sanitiseQuantityText("123456789012345")).toBe("12345678901");
  });

  it("leaves a typed quantity that parseQuantity accepts unchanged", () => {
    for (const text of ["0", "10", "2.5", "0.001", "99999999999.999"]) expect(sanitiseQuantityText(text)).toBe(text);
  });
});
