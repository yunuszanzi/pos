import { describe, expect, it } from "vitest";
import { describeStock, groupDigits } from "../../src/features/stock/stockFormat";

const names: Record<string, string> = { pc: "Piece", pk: "Pack", ctn: "Carton" };
const name = (unitId: string) => names[unitId];
const units = [
  { unitId: "pc", factorToBase: "1", isBase: true },
  { unitId: "pk", factorToBase: "10", isBase: false },
  { unitId: "ctn", factorToBase: "200", isBase: false },
];

describe("groupDigits", () => {
  it.each([["0", "0"], ["999", "999"], ["2000", "2,000"], ["1234567.5", "1,234,567.5"], ["-1234.5", "-1,234.5"]])("%s", (input, expected) => {
    expect(groupDigits(input)).toBe(expected);
  });
});

describe("describeStock", () => {
  it("shows 2,000 pieces as 10 cartons (acceptance: 10 cartons = 2,000 pieces)", () => {
    expect(describeStock("2000", units, name)).toEqual({ main: "2,000 Piece", detail: "10 Carton" });
  });

  it("splits across larger units and keeps the remainder in pieces", () => {
    expect(describeStock("2057", units, name).detail).toBe("10 Carton + 5 Pack + 7 Piece");
  });

  it("shows no detail when less than one larger unit is in stock, or for single-unit products", () => {
    expect(describeStock("7", units, name).detail).toBe("");
    expect(describeStock("2000", [units[0]], name).detail).toBe("");
    expect(describeStock("0", units, name)).toEqual({ main: "0 Piece", detail: "" });
  });

  it("does not break down negative stock", () => {
    expect(describeStock("-5", units, name)).toEqual({ main: "-5 Piece", detail: "" });
  });

  it("handles fractional base quantities", () => {
    expect(describeStock("12.5", [{ unitId: "pc", factorToBase: "1", isBase: true }, { unitId: "pk", factorToBase: "10", isBase: false }], name).detail).toBe("1 Pack + 2.5 Piece");
  });
});
