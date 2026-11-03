import { describe, expect, it } from "vitest";
import { CsvError, csvToRecords, neutraliseFormula, parseCsv, toCsv } from "../../shared/csv";

describe("parseCsv", () => {
  it("parses plain rows with LF and CRLF endings", () => {
    expect(parseCsv("a,b\n1,2\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("strips a UTF-8 byte order mark added by Excel", () => {
    expect(parseCsv("﻿sku,name\nA1,Balloon")).toEqual([["sku", "name"], ["A1", "Balloon"]]);
  });

  it("keeps commas, quotes and newlines inside quoted cells", () => {
    expect(parseCsv('name,note\n"Balloon, 12 inch","say ""hi""\nthere"')).toEqual([
      ["name", "note"],
      ["Balloon, 12 inch", 'say "hi"\nthere'],
    ]);
  });

  it("keeps empty cells and a trailing empty cell", () => {
    expect(parseCsv("a,b,c\n1,,\n,2,")).toEqual([["a", "b", "c"], ["1", "", ""], ["", "2", ""]]);
  });

  it("skips blank lines", () => {
    expect(parseCsv("a\n\n1\n\n")).toEqual([["a"], ["1"]]);
  });

  it("rejects an unclosed quote and a stray quote", () => {
    expect(() => parseCsv('a\n"open')).toThrow(CsvError);
    expect(() => parseCsv('a\nab"c')).toThrow(CsvError);
  });

  it("handles a large file", () => {
    const body = Array.from({ length: 5000 }, (_, index) => `SKU-${index},Item ${index},10.50`).join("\n");
    expect(parseCsv(`sku,name,price\n${body}`)).toHaveLength(5001);
  });
});

describe("toCsv", () => {
  it("quotes cells that need it and round-trips through parseCsv", () => {
    const rows = [["sku", "name"], ["A1", 'Big "12 inch", red'], ["A2", "two\nlines"], ["A3", ""]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("writes numbers as-is and nulls as empty cells", () => {
    expect(toCsv([["a", 5, null, undefined]])).toBe("a,5,,\r\n");
  });

  it("neutralises cells a spreadsheet would run as formulas", () => {
    expect(neutraliseFormula("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutraliseFormula("@cmd")).toBe("'@cmd");
    expect(neutraliseFormula("+92 300")).toBe("'+92 300");
    expect(neutraliseFormula("Plain")).toBe("Plain");
    expect(toCsv([["=1+1"]])).toBe("'=1+1\r\n");
  });
});

describe("csvToRecords", () => {
  it("normalises header names and trims cells", () => {
    const { headers, records } = csvToRecords(parseCsv("SKU, Sale Price ,Name\n A1 , 10 ,Balloon"));
    expect(headers).toEqual(["sku", "sale_price", "name"]);
    expect(records).toEqual([{ sku: "A1", sale_price: "10", name: "Balloon" }]);
  });

  it("fills missing trailing cells with empty strings", () => {
    expect(csvToRecords(parseCsv("a,b\n1")).records).toEqual([{ a: "1", b: "" }]);
  });

  it("rejects an empty file and duplicate columns", () => {
    expect(() => csvToRecords([])).toThrow(CsvError);
    expect(() => csvToRecords(parseCsv("sku,sku\n1,2"))).toThrow(/appears twice/);
  });
});
