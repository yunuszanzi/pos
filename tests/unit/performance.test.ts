import { describe, expect, it } from "vitest";
import type { Product } from "../../src/api/productsApi";
import { CatalogueIndex } from "../../src/pos/catalogueIndex";

// NFR-PRF-01: a product search or scan answers in under 300 ms for a catalogue of 20,000 SKUs. On the till both run on the device, from
// the local copy of the catalogue, so this is what the cashier waits for. Each SKU is sold in three units, as the balloon trade does.

const SKUS = 20_000;
const words = ["Balloon", "Latex", "Foil", "Ribbon", "Banner", "Candle", "Party", "Gift", "Wrapper", "Confetti"];
const colours = ["Red", "Blue", "Green", "Gold", "Silver", "Pink", "White", "Black", "Yellow", "Purple"];

const catalogue: Product[] = Array.from({ length: SKUS }, (_, n) => ({
  id: `p${n}`, name: `${colours[n % 10]} ${words[Math.floor(n / 10) % 10]} ${n}`, active: true, productType: "stocked", categoryId: null, taxCategoryId: "gst", baseUnitId: "u-pc",
  variants: [{
    id: `v${n}`, sku: `SKU-${String(n).padStart(6, "0")}`, variantName: "", active: true, costPaisa: 100, reorderLevel: "0",
    units: [
      { unitId: "u-pc", factorToBase: "1", isBase: true, barcode: `890${String(n).padStart(9, "0")}`, salePricePaisa: 500 },
      { unitId: "u-pk", factorToBase: "10", isBase: false, barcode: `891${String(n).padStart(9, "0")}`, salePricePaisa: 4800 },
      { unitId: "u-ct", factorToBase: "200", isBase: false, barcode: `892${String(n).padStart(9, "0")}`, salePricePaisa: 90000 },
    ],
  }],
} as unknown as Product));
const reference = { units: [{ id: "u-pc", name: "Piece" }, { id: "u-pk", name: "Pack" }, { id: "u-ct", name: "Carton" }], taxCategories: [{ id: "gst", rateBps: 1800 }] };

const timed = <T>(work: () => T) => { const start = performance.now(); const result = work(); return { result, ms: performance.now() - start }; };
const worst = (times: number[]) => Math.max(...times);

describe(`a catalogue of ${SKUS.toLocaleString("en")} SKUs (NFR-PRF-01)`, () => {
  const built = timed(() => new CatalogueIndex(catalogue, reference as never));
  const index = built.result;

  it("holds every SKU in every unit, and opens quickly enough for a till to start", () => {
    expect(index.size).toBe(SKUS * 3);
    expect(built.ms).toBeLessThan(3000);
  });

  it("answers a barcode scan in well under 300 ms, every time", () => {
    const times = Array.from({ length: 500 }, (_, i) => timed(() => index.findByBarcode(`890${String((i * 37) % SKUS).padStart(9, "0")}`)).ms);
    expect(timed(() => index.findByBarcode("890000012345")).result?.sku).toBe("SKU-012345");
    expect(timed(() => index.findByBarcode("0000000000000")).result).toBeUndefined();
    expect(worst(times)).toBeLessThan(300);
  });

  it("answers a typed search in under 300 ms: by SKU, by name, by several words, by a word that is nowhere", () => {
    const queries = ["SKU-012345", "sku-0199", "Red Balloon", "red balloon 1234", "gold foil", "confetti pink 9", "party", "zzzz-not-here", "12", "latex blue 19999"];
    const times: number[] = [];
    for (const query of queries) for (let repeat = 0; repeat < 20; repeat += 1) times.push(timed(() => index.search(query)).ms);
    expect(index.search("SKU-012345")[0]?.sku).toBe("SKU-012345");
    expect(index.search("Red Balloon").length).toBeGreaterThan(0);
    expect(index.search("zzzz-not-here")).toEqual([]);
    expect(worst(times)).toBeLessThan(300);
  });

  it("treats a typed barcode like a scan", () => {
    expect(timed(() => index.search("890000000007")).result.map((entry) => entry.sku)).toEqual(["SKU-000007"]);
  });
});
