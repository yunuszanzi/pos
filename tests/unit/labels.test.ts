import { describe, expect, it } from "vitest";
import { barcodeSymbology, expandLabels, labelFormats, labelPageCss, labelsPerPage, layoutLabels, maxLabelsPerPrint } from "../../shared/labels";

const format = (id: string) => labelFormats.find((candidate) => candidate.id === id)!;

describe("expandLabels", () => {
  it("repeats each item by its copies, in order", () => {
    expect(expandLabels([{ key: "a", copies: 2 }, { key: "b", copies: 1 }, { key: "c", copies: 0 }]).map((label) => label.key)).toEqual(["a", "a", "b"]);
  });

  it("refuses fractional or negative copies and absurd totals", () => {
    expect(() => expandLabels([{ key: "a", copies: 1.5 }])).toThrow(RangeError);
    expect(() => expandLabels([{ key: "a", copies: -1 }])).toThrow(RangeError);
    expect(() => expandLabels([{ key: "a", copies: maxLabelsPerPrint + 1 }])).toThrow(/at most 1000/);
    expect(expandLabels([{ key: "a", copies: maxLabelsPerPrint }])).toHaveLength(maxLabelsPerPrint);
  });
});

describe("layoutLabels", () => {
  const labels = Array.from({ length: 30 }, (_, index) => index + 1);

  it("fills a 24-up sheet and starts a second one", () => {
    const pages = layoutLabels(labels, format("a4-24"));
    expect(labelsPerPage(format("a4-24"))).toBe(24);
    expect(pages.map((page) => page.length)).toEqual([24, 6]);
    expect(pages[1]).toEqual([25, 26, 27, 28, 29, 30]);
  });

  it("leaves the first positions empty on a partly used sheet", () => {
    const pages = layoutLabels([1, 2, 3], format("a4-24"), 23);
    expect(pages).toHaveLength(2);
    // Position 23 is the 23rd cell: two labels fit on this sheet, the third starts the next.
    expect(pages[0].slice(21)).toEqual([null, 1, 2]);
    expect(pages[0].filter((cell) => cell === null)).toHaveLength(22);
    expect(pages[1]).toEqual([3]);
  });

  it("puts one label on each roll page and ignores the start position", () => {
    expect(layoutLabels([1, 2, 3], format("roll-50x30"), 5)).toEqual([[1], [2], [3]]);
  });

  it("rejects a start position outside the sheet", () => {
    expect(() => layoutLabels([1], format("a4-24"), 0)).toThrow(RangeError);
    expect(() => layoutLabels([1], format("a4-24"), 25)).toThrow(/between 1 and 24/);
    expect(() => layoutLabels([1], format("a4-24"), 1.5)).toThrow(RangeError);
  });

  it("returns no pages for no labels", () => {
    expect(layoutLabels([], format("a4-24"))).toEqual([]);
  });
});

describe("barcodeSymbology", () => {
  it("prints a valid EAN-13 as EAN-13", () => {
    expect(barcodeSymbology("4006381333931")).toBe("ean13");
  });

  it("falls back to Code 128 for everything else", () => {
    expect(barcodeSymbology("4006381333932")).toBe("code128"); // bad check digit
    expect(barcodeSymbology("BAL-12-RED")).toBe("code128");
    expect(barcodeSymbology("12345")).toBe("code128");
  });
});

describe("labelPageCss", () => {
  it("sizes a sheet page and its grid from the format", () => {
    const css = labelPageCss(format("a4-24"));
    expect(css).toContain("size: A4");
    expect(css).toContain("repeat(3, 63.5mm)");
    expect(css).toContain("grid-auto-rows: 33.9mm");
  });

  it("sizes each roll label as its own page", () => {
    const css = labelPageCss(format("roll-50x30"));
    expect(css).toContain("size: 50mm 30mm");
    expect(css).toContain("page-break-after: always");
  });

  it("every sheet format fits on an A4 page", () => {
    for (const candidate of labelFormats) {
      if (candidate.kind !== "sheet") continue;
      const width = candidate.marginLeftMm + candidate.columns * candidate.labelWidthMm + (candidate.columns - 1) * candidate.gapXMm;
      const height = candidate.marginTopMm + candidate.rows * candidate.labelHeightMm + (candidate.rows - 1) * candidate.gapYMm;
      expect(width, candidate.id).toBeLessThanOrEqual(210);
      expect(height, candidate.id).toBeLessThanOrEqual(297);
    }
  });
});
