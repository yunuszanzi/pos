import { describe, expect, it } from "vitest";
import { barcodeImageUrl } from "../../src/features/labels/barcodeImage";

const svgOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

describe("barcodeImageUrl", () => {
  it("draws an SVG for a retail EAN-13", () => {
    const url = barcodeImageUrl("4006381333931");
    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    expect(svgOf(url)).toContain("<svg");
  });

  it("draws an SVG for an internal Code 128 value", () => {
    expect(svgOf(barcodeImageUrl("BAL-12-RED"))).toContain("<svg");
  });

  it("draws different images for different values and reuses the same one for the same value", () => {
    expect(barcodeImageUrl("AAA-1")).not.toBe(barcodeImageUrl("AAA-2"));
    expect(barcodeImageUrl("AAA-1")).toBe(barcodeImageUrl("AAA-1"));
  });

  it("cannot be used to inject markup: the SVG never contains the raw value as tags", () => {
    const svg = svgOf(barcodeImageUrl("<script>alert(1)</script>"));
    expect(svg).not.toContain("<script");
  });
});
