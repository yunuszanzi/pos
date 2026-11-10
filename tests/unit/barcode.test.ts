import { describe, expect, it } from "vitest";
import { ean13CheckDigit, generateInternalEan13, isValidEan13 } from "../../shared/barcode";

describe("EAN-13", () => {
  it.each([
    ["400638133393", 1],
    ["590123412345", 7],
    ["978020137962", 4],
    ["000000000000", 0],
  ])("check digit of %s is %i", (first12, expected) => {
    expect(ean13CheckDigit(first12)).toBe(expected);
  });

  it("validates complete codes", () => {
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidEan13("400638133393")).toBe(false);
    expect(isValidEan13("abcdefghijklm")).toBe(false);
  });

  it("rejects input that is not 12 digits", () => {
    expect(() => ean13CheckDigit("123")).toThrow(RangeError);
    expect(() => ean13CheckDigit("12345678901a")).toThrow(RangeError);
  });

  it("generates valid in-store codes", () => {
    for (let run = 0; run < 200; run += 1) {
      const code = generateInternalEan13();
      expect(code).toHaveLength(13);
      expect(code.startsWith("20")).toBe(true);
      expect(isValidEan13(code)).toBe(true);
    }
  });

  it("is deterministic for a given random source", () => {
    let counter = 0;
    const sequence = () => (counter++ % 10) / 10;
    expect(generateInternalEan13(sequence)).toBe("2001234567893");
  });
});
