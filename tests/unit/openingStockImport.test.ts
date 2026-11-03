import { describe, expect, it } from "vitest";
import { csvToRecords, parseCsv } from "../../shared/csv";
import { analyseOpeningStock, maxOpeningStockRows, openingStockTemplateRows, type OpeningStockLookups } from "../../shared/openingStockImport";

const units = [
  { unitId: "u-piece", name: "Piece", shortName: "pc", factorToBaseMilli: 1000 },
  { unitId: "u-carton", name: "Carton", shortName: "ctn", factorToBaseMilli: 200000 },
];
const sku = (overrides = {}) => ({ variantId: "v1", productType: "stocked" as const, active: true, baseUnitId: "u-piece", costPaisa: 300, units, ...overrides });

const lookups = (overrides: Partial<OpeningStockLookups> = {}): OpeningStockLookups => ({
  variantsBySku: new Map([["bal-red", sku()], ["bal-blu", sku({ variantId: "v2" })]]),
  locationIdsByName: new Map([["main store", "loc-1"], ["warehouse", "loc-2"]]),
  defaultLocationId: "loc-1",
  withMovements: new Set(),
  canSetCost: true,
  ...overrides,
});

function analyse(csv: string, withLookups = lookups()) {
  const { headers, records } = csvToRecords(parseCsv(csv));
  return analyseOpeningStock(headers, records, withLookups);
}

describe("analyseOpeningStock", () => {
  it("turns 10 cartons of 200 pieces into 2,000 pieces", () => {
    const result = analyse("sku,quantity,unit\nBAL-RED,10,Carton");
    expect(result.issues).toEqual([]);
    expect(result.byLocation.get("loc-1")).toEqual([
      { row: 2, variantId: "v1", unitId: "u-carton", quantity: "10", baseMilli: 2_000_000, costPerBasePaisa: null },
    ]);
  });

  it("defaults to the base unit and accepts a short unit name", () => {
    const result = analyse("sku,quantity,unit\nBAL-RED,500,\nBAL-BLU,2,ctn");
    expect(result.issues).toEqual([]);
    expect(result.byLocation.get("loc-1")?.map((line) => [line.unitId, line.baseMilli])).toEqual([["u-piece", 500_000], ["u-carton", 400_000]]);
  });

  it("converts a cost given per carton into a cost per piece", () => {
    const result = analyse("sku,quantity,unit,cost\nBAL-RED,10,Carton,3200.00\nBAL-BLU,5,Piece,16.50");
    expect(result.byLocation.get("loc-1")?.map((line) => line.costPerBasePaisa)).toEqual([1600, 1650]);
  });

  it("rounds a cost per piece to the nearest paisa", () => {
    // Rs 10.00 per carton of 200 = 0.5 paisa per piece -> 1 (half away from zero)
    expect(analyse("sku,quantity,unit,cost\nBAL-RED,1,Carton,10.00").byLocation.get("loc-1")?.[0].costPerBasePaisa).toBe(5);
  });

  it("groups lines by location and needs a location when there are several", () => {
    const result = analyse("sku,quantity,location\nBAL-RED,1,Main Store\nBAL-BLU,2,Warehouse");
    expect([...result.byLocation.keys()].sort()).toEqual(["loc-1", "loc-2"]);
    const noDefault = analyse("sku,quantity\nBAL-RED,1", lookups({ defaultLocationId: null }));
    expect(noDefault.issues).toEqual([{ row: 2, field: "location", message: "Name the location; this business has more than one" }]);
  });

  it("reports each problem with its row and column", () => {
    const many = lookups({
      variantsBySku: new Map(Array.from({ length: 6 }, (_, index) => [`sku-${index}`, sku({ variantId: `v${index}` })])),
    });
    const result = analyse([
      "sku,quantity,unit,cost,location",
      "NOPE,1,,,",
      "SKU-1,abc,,,",
      "SKU-2,0,,,",
      "SKU-3,1,Bucket,,",
      "SKU-4,1,,x,",
      "SKU-5,1,,,Moon",
    ].join("\n"), many);
    expect(result.issues.map((issue) => `${issue.row}:${issue.field}`)).toEqual(["2:sku", "3:quantity", "4:quantity", "5:unit", "6:cost", "7:location"]);
  });

  it("rejects archived and non-stocked SKUs", () => {
    const result = analyse("sku,quantity\nBAL-RED,1\nBAL-BLU,1", lookups({
      variantsBySku: new Map([["bal-red", sku({ active: false })], ["bal-blu", sku({ variantId: "v2", productType: "service" })]]),
    }));
    expect(result.issues.map((issue) => issue.message)).toEqual(['SKU "BAL-RED" is archived', 'SKU "BAL-BLU" is not a stocked item, so it has no stock']);
  });

  it("refuses SKUs that already have stock movements, and duplicates in the file", () => {
    const moved = analyse("sku,quantity\nBAL-RED,1", lookups({ withMovements: new Set(["v1|loc-1"]) }));
    expect(moved.issues[0].message).toContain("already has stock movements");
    const twice = analyse("sku,quantity\nBAL-RED,1\nbal-red,2");
    expect(twice.issues).toEqual([{ row: 3, field: "sku", message: '"bal-red" already appears on row 2 for this location' }]);
    const otherPlace = analyse("sku,quantity,location\nBAL-RED,1,Main Store\nBAL-RED,2,Warehouse");
    expect(otherPlace.issues).toEqual([]);
  });

  it("only lets users who can see costs import them", () => {
    const denied = analyse("sku,quantity,cost\nBAL-RED,1,5", lookups({ canSetCost: false }));
    expect(denied.issues[0]).toMatchObject({ row: 2, field: "cost" });
    expect(analyse("sku,quantity,cost\nBAL-RED,1,", lookups({ canSetCost: false })).issues).toEqual([]);
  });

  it("rejects missing columns, unknown columns, empty files and too many rows", () => {
    expect(analyse("sku\nBAL-RED").issues[0]).toMatchObject({ row: 1, field: "quantity" });
    expect(analyse("sku,quantity,stock\nBAL-RED,1,1").issues[0]).toMatchObject({ row: 1, field: "stock" });
    expect(analyse("sku,quantity").issues[0].message).toContain("no stock rows");
    const records = Array.from({ length: maxOpeningStockRows + 1 }, (_, index) => ({ sku: `S${index}`, quantity: "1" }));
    expect(analyseOpeningStock(["sku", "quantity"], records, lookups()).issues[0].message).toContain(String(maxOpeningStockRows));
  });

  it("accepts the downloadable template", () => {
    const { headers, records } = csvToRecords(openingStockTemplateRows);
    const result = analyseOpeningStock(headers, records, lookups({
      variantsBySku: new Map([["bal-12-red", sku()], ["bal-12-blu", sku({ variantId: "v2" })]]),
    }));
    expect(result.issues).toEqual([]);
    expect(result.lineCount).toBe(2);
  });
});
