import { code128, drawingSVG, ean13 } from "bwip-js/browser";
import { barcodeSymbology } from "../../../shared/labels";

const cache = new Map<string, string>();

/**
 * A barcode as an image URL. The SVG is rendered through an <img>, never inserted as markup, so nothing in a
 * barcode value can run as script or HTML. A valid EAN-13 prints as EAN-13, anything else as Code 128.
 */
export function barcodeImageUrl(code: string): string {
  const cached = cache.get(code);
  if (cached) return cached;
  const look = { text: code, scale: 2, height: 9, includetext: true, textxalign: "center" as const, textsize: 9 };
  const svg = barcodeSymbology(code) === "ean13"
    ? ean13({ bcid: "ean13", ...look }, drawingSVG())
    : code128({ bcid: "code128", ...look }, drawingSVG());
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(code, url);
  return url;
}
