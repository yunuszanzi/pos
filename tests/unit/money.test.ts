import { describe, expect, it } from "vitest";
import { divideRounded, formatPkr, formatRupees, lineValue, parseRupees } from "../../shared/money";

describe("parseRupees", () => {
  it.each([
    ["0", 0],
    ["5", 500],
    ["5.5", 550],
    ["5.05", 505],
    ["1234.50", 123450],
    ["1,234.50", 123450],
    ["12,34,567", null],
    ["-10.25", -1025],
    [" 7 ", 700],
  ])("parses %s", (input, expected) => {
    if (expected === null) expect(() => parseRupees(input)).toThrow(RangeError);
    else expect(parseRupees(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "1..2", "1,23", ".5", "5.", "1e3"])("rejects %j", (input) => {
    expect(() => parseRupees(input)).toThrow(RangeError);
  });

  it("is exact for amounts that floating point cannot hold", () => {
    expect(parseRupees("0.1") + parseRupees("0.2")).toBe(30);
    expect(parseRupees("1234567890123.45")).toBe(123456789012345);
  });
});

describe("formatRupees", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [100, "1.00"],
    [123450, "1,234.50"],
    [-1025, "-10.25"],
    [100000000, "1,000,000.00"],
  ])("formats %i paisa", (paisa, expected) => {
    expect(formatRupees(paisa)).toBe(expected);
  });

  it("round-trips through parseRupees", () => {
    for (const paisa of [0, 1, 99, 100, 101, 999999, 123456789, -5]) {
      expect(parseRupees(formatRupees(paisa))).toBe(paisa);
    }
  });

  it("adds the currency prefix", () => {
    expect(formatPkr(150000)).toBe("Rs 1,500.00");
  });

  it("refuses non-integer paisa", () => {
    expect(() => formatRupees(10.5)).toThrow(RangeError);
  });
});

describe("divideRounded", () => {
  it.each([
    [10n, 4n, 3n],
    [9n, 4n, 2n],
    [-10n, 4n, -3n],
    [10n, -4n, -3n],
    [-9n, -4n, 2n],
    [7n, 7n, 1n],
    [0n, 5n, 0n],
  ])("%s / %s rounds half away from zero to %s", (n, d, expected) => {
    expect(divideRounded(n, d)).toBe(expected);
  });

  it("rejects division by zero", () => {
    expect(() => divideRounded(1n, 0n)).toThrow(RangeError);
  });
});

describe("lineValue", () => {
  it("multiplies thousandths of a unit by a unit cost in paisa", () => {
    expect(lineValue(2000, 12550)).toBe(25100);
    expect(lineValue(500, 12550)).toBe(6275);
    expect(lineValue(1, 12550)).toBe(13);
    expect(lineValue(0, 12550)).toBe(0);
    expect(lineValue(-3000, 400)).toBe(-1200);
  });
});
