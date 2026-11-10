import { isValidEan13 } from "./barcode";

// Barcode label printing (FR-PRD-10). Sizes below are the common layouts for A4 label sheets and a thermal label
// roll; check them against your own label stock with a test print before printing a full sheet.

export type LabelFormat =
  | { id: string; name: string; kind: "sheet"; columns: number; rows: number; labelWidthMm: number; labelHeightMm: number; marginTopMm: number; marginLeftMm: number; gapXMm: number; gapYMm: number }
  | { id: string; name: string; kind: "roll"; labelWidthMm: number; labelHeightMm: number };

export const labelFormats: LabelFormat[] = [
  { id: "a4-24", name: "A4 sheet · 24 labels (3 × 8, 63.5 × 33.9 mm)", kind: "sheet", columns: 3, rows: 8, labelWidthMm: 63.5, labelHeightMm: 33.9, marginTopMm: 12.9, marginLeftMm: 7.2, gapXMm: 2.5, gapYMm: 0 },
  { id: "a4-40", name: "A4 sheet · 40 labels (4 × 10, 48.5 × 25.4 mm)", kind: "sheet", columns: 4, rows: 10, labelWidthMm: 48.5, labelHeightMm: 25.4, marginTopMm: 21.5, marginLeftMm: 8.5, gapXMm: 2.5, gapYMm: 0 },
  { id: "roll-50x30", name: "Label roll · 50 × 30 mm, one per label", kind: "roll", labelWidthMm: 50, labelHeightMm: 30 },
];

export const maxLabelsPerPrint = 1000;

export type LabelRequest = { key: string; copies: number };

/** One entry per label to print: each item repeated `copies` times, in order. */
export function expandLabels<T extends LabelRequest>(items: T[], max = maxLabelsPerPrint): T[] {
  const total = items.reduce((sum, item) => sum + item.copies, 0);
  if (items.some((item) => !Number.isInteger(item.copies) || item.copies < 0)) throw new RangeError("Copies must be a whole number");
  if (total > max) throw new RangeError(`That is ${total} labels; print at most ${max} at a time`);
  return items.flatMap((item) => Array.from({ length: item.copies }, () => item));
}

export const labelsPerPage = (format: LabelFormat) => (format.kind === "sheet" ? format.columns * format.rows : 1);

/**
 * Splits labels into printed pages. `startPosition` (1-based) leaves the first positions of the first sheet empty,
 * for a sheet that was already partly used. A roll has one label per page and ignores it.
 */
export function layoutLabels<T>(labels: T[], format: LabelFormat, startPosition = 1): Array<Array<T | null>> {
  if (format.kind === "roll") return labels.map((label) => [label]);
  const perPage = labelsPerPage(format);
  if (!Number.isInteger(startPosition) || startPosition < 1 || startPosition > perPage) {
    throw new RangeError(`The start position must be between 1 and ${perPage}`);
  }
  const cells: Array<T | null> = [...Array.from({ length: startPosition - 1 }, () => null), ...labels];
  const pages: Array<Array<T | null>> = [];
  for (let index = 0; index < cells.length; index += perPage) pages.push(cells.slice(index, index + perPage));
  return pages;
}

export type Symbology = "ean13" | "code128";

/** A valid 13-digit EAN prints as EAN-13 so scanners treat it as a retail code; anything else prints as Code 128. */
export function barcodeSymbology(code: string): Symbology {
  return isValidEan13(code) ? "ean13" : "code128";
}

/** CSS for the printed page: its size, and the grid that places each label. Numbers only come from labelFormats. */
export function labelPageCss(format: LabelFormat): string {
  if (format.kind === "roll") {
    return `@page { size: ${format.labelWidthMm}mm ${format.labelHeightMm}mm; margin: 0; }
.label-page { width: ${format.labelWidthMm}mm; height: ${format.labelHeightMm}mm; page-break-after: always; break-after: page; }
.label-cell { width: ${format.labelWidthMm}mm; height: ${format.labelHeightMm}mm; }`;
  }
  return `@page { size: A4; margin: 0; }
.label-page { width: 210mm; height: 297mm; box-sizing: border-box; padding: ${format.marginTopMm}mm 0 0 ${format.marginLeftMm}mm; page-break-after: always; break-after: page;
  display: grid; grid-template-columns: repeat(${format.columns}, ${format.labelWidthMm}mm); grid-auto-rows: ${format.labelHeightMm}mm;
  column-gap: ${format.gapXMm}mm; row-gap: ${format.gapYMm}mm; align-content: start; }
.label-cell { width: ${format.labelWidthMm}mm; height: ${format.labelHeightMm}mm; }`;
}
