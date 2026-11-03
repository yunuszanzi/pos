import { describe, expect, it } from "vitest";
import { csvToRecords } from "../../shared/csv";
import { analyseProductImport, importTemplateCsvRows, maxImportRows, type ImportLookups } from "../../shared/productImport";

const lookups = (overrides: Partial<ImportLookups> = {}): ImportLookups => ({
  taxCategoryIdsByName: new Map([["standard rate 18%", "tax-standard"], ["exempt", "tax-exempt"]]),
  unitIdsByName: new Map([["piece", "u-piece"], ["carton", "u-carton"], ["pack", "u-pack"]]),
  existingSkus: new Map(),
  existingBarcodes: new Map(),
  canSetCost: true,
  ...overrides,
});

function analyse(csv: string, withLookups = lookups()) {
  const { headers, records } = csvToRecords(csv.trim().split("\n").map((line) => line.split(",")));
  return analyseProductImport(headers, records, withLookups);
}

describe("analyseProductImport", () => {
  it("accepts the downloadable template", () => {
    const { headers, records } = csvToRecords(importTemplateCsvRows);
    const result = analyseProductImport(headers, records, lookups());
    expect(result.issues).toEqual([]);
    expect(result.products).toHaveLength(1);
    expect(result.products[0].variants).toHaveLength(2);
    expect(result.variantsToCreate).toBe(2);
    expect(result.categoryPaths).toEqual([["Balloons"], ["Balloons", "Latex"]]);
    expect(result.brands).toEqual(["Party Co"]);
  });

  it("turns a row into a product with prices in paisa and quantities as strings", () => {
    const result = analyse("sku,name,sale_price,cost,reorder_level\nA1,Pump,1250.50,900,12.5");
    expect(result.issues).toEqual([]);
    const [product] = result.products;
    expect(product.baseUnitId).toBe("u-piece");
    expect(product.variants[0]).toMatchObject({ sku: "A1", costPaisa: 90000, reorderLevel: "12.5" });
    expect(product.variants[0].units).toEqual([{ unitId: "u-piece", factorToBase: "1", barcode: null, salePricePaisa: 125050 }]);
  });

  it("adds an alternative unit with its factor, barcode and price", () => {
    const result = analyse("sku,name,sale_price,alt_unit,alt_factor,alt_barcode,alt_price\nA1,Pump,10,Carton,200,CTN1,1800");
    expect(result.issues).toEqual([]);
    expect(result.products[0].variants[0].units[1]).toEqual({ unitId: "u-carton", factorToBase: "200", barcode: "CTN1", salePricePaisa: 180000 });
  });

  it("groups rows with the same product name into variants", () => {
    const result = analyse("sku,name,variant_name\nR1,Balloon,Red\nB1,balloon,Blue\nP1,Pump,");
    expect(result.issues).toEqual([]);
    expect(result.products.map((product) => [product.name, product.variants.length])).toEqual([["Balloon", 2], ["Pump", 1]]);
  });

  it("reports every problem with its row and column, numbering rows as a spreadsheet does", () => {
    const result = analyse([
      "sku,name,sale_price,tax_category,hs_code,barcode,base_unit",
      ",Missing sku,5,,,,",
      "A2,Bad price,12.345,,,,",
      "A3,Bad tax,5,Luxury,,,",
      "A4,Bad hs,5,,ab,,",
      "A5,Bad barcode,5,,,has space,",
      "A6,Bad unit,5,,,,Bucket",
    ].join("\n"));
    expect(result.issues.map((issue) => `${issue.row}:${issue.field}`)).toEqual([
      "2:sku", "3:sale_price", "4:tax_category", "5:hs_code", "6:barcode", "7:base_unit",
    ]);
    expect(result.issues[1].message).toContain("12.345");
  });

  it("flags a duplicate SKU and a duplicate barcode inside the file", () => {
    const result = analyse("sku,name,barcode\nA1,One,111\nA1,Two,222\nA3,Three,111");
    expect(result.issues).toEqual([
      { row: 3, field: "sku", message: 'SKU "A1" already appears on row 2' },
      { row: 4, field: "barcode", message: "Barcode 111 already appears on row 2" },
    ]);
  });

  it("matches SKUs case-insensitively and updates existing variants", () => {
    const result = analyse("sku,name,sale_price\nA1,Pump,10\nNEW,Hose,5", lookups({
      existingSkus: new Map([["a1", { variantId: "v1", productId: "p1", baseUnitId: "u-piece" }]]),
    }));
    expect(result.issues).toEqual([]);
    expect(result.variantsToUpdate).toBe(1);
    expect(result.variantsToCreate).toBe(1);
    expect(result.products[0].existingProductId).toBe("p1");
    expect(result.products[0].variants[0].existingVariantId).toBe("v1");
  });

  it("allows a variant to keep its own barcode but not take another product's", () => {
    const existing = lookups({
      existingSkus: new Map([["a1", { variantId: "v1", productId: "p1", baseUnitId: "u-piece" }]]),
      existingBarcodes: new Map([["111", "v1"], ["222", "v-other"]]),
    });
    expect(analyse("sku,name,barcode\nA1,Pump,111", existing).issues).toEqual([]);
    const clash = analyse("sku,name,barcode\nA1,Pump,222", existing);
    expect(clash.issues).toEqual([{ row: 2, field: "barcode", message: "Barcode 222 already belongs to another product" }]);
  });

  it("requires rows of one product to agree on shared fields", () => {
    const result = analyse("sku,name,hs_code,tax_category\nR1,Balloon,9503.0090,Exempt\nB1,Balloon,9503.0000,Standard rate 18%");
    expect(result.issues.map((issue) => issue.field)).toEqual(["tax_category", "hs_code"]);
  });

  it("refuses SKUs of one product that belong to different existing products", () => {
    const result = analyse("sku,name\nA1,Balloon\nB1,Balloon", lookups({
      existingSkus: new Map([["a1", { variantId: "v1", productId: "p1", baseUnitId: "u-piece" }], ["b1", { variantId: "v2", productId: "p2", baseUnitId: "u-piece" }]]),
    }));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("different existing products");
  });

  it("treats blank cells on a new SKU as defaults and on an existing SKU as 'leave unchanged'", () => {
    const fresh = analyse("sku,name,sale_price,cost,variant_name\nNEW,Hose,,,");
    expect(fresh.issues).toEqual([]);
    expect(fresh.products[0].variants[0]).toMatchObject({ costPaisa: null, variantName: null, reorderLevel: null });
    expect(fresh.products[0].variants[0].units[0].salePricePaisa).toBeNull();

    const known = lookups({ existingSkus: new Map([["a1", { variantId: "v1", productId: "p1", baseUnitId: "u-piece" }]]) });
    const blank = analyse("sku,name,sale_price,cost\nA1,Pump,,", known);
    expect(blank.products[0].variants[0].costPaisa).toBeNull();
    expect(blank.products[0].variants[0].units[0].salePricePaisa).toBeNull();
    const priced = analyse("sku,name,sale_price,cost\nA1,Pump,0,0", known);
    expect(priced.products[0].variants[0].costPaisa).toBe(0);
    expect(priced.products[0].variants[0].units[0].salePricePaisa).toBe(0);
  });

  it("lets a blank cell in one row of a product defer to another row", () => {
    const result = analyse("sku,name,brand,hs_code\nR1,Balloon,Party Co,\nB1,Balloon,,9503.0090");
    expect(result.issues).toEqual([]);
    expect(result.products[0]).toMatchObject({ brand: "Party Co", hsCode: "9503.0090" });
  });

  it("only lets users who can see costs import them", () => {
    const denied = analyse("sku,name,cost\nA1,Pump,50", lookups({ canSetCost: false }));
    expect(denied.issues).toEqual([{ row: 2, field: "cost", message: "You do not have permission to import cost prices; leave this column empty" }]);
    expect(analyse("sku,name,cost\nA1,Pump,", lookups({ canSetCost: false })).issues).toEqual([]);
  });

  it("will not change the base unit of an existing product, and keeps it when the column is blank", () => {
    const known = lookups({ existingSkus: new Map([["a1", { variantId: "v1", productId: "p1", baseUnitId: "u-piece" }]]) });
    expect(analyse("sku,name,base_unit\nA1,Pump,Pack", known).issues).toEqual([
      { row: 2, field: "base_unit", message: "The base unit of an existing product cannot be changed by import" },
    ]);
    expect(analyse("sku,name,base_unit\nA1,Pump,Piece", known).issues).toEqual([]);
    const kept = analyse("sku,name\nA1,Pump", lookups({ existingSkus: new Map([["a1", { variantId: "v1", productId: "p1", baseUnitId: "u-pack" }]]) }));
    expect(kept.issues).toEqual([]);
    expect(kept.products[0].baseUnitId).toBe("u-pack");
  });

  it("validates the alternative unit", () => {
    expect(analyse("sku,name,alt_unit,alt_factor\nA1,One,Carton,").issues[0].field).toBe("alt_factor");
    expect(analyse("sku,name,alt_unit,alt_factor\nA1,One,Carton,0").issues[0].field).toBe("alt_factor");
    expect(analyse("sku,name,alt_unit,alt_factor\nA1,One,Piece,12").issues[0].field).toBe("alt_unit");
    expect(analyse("sku,name,alt_unit,alt_factor\nA1,One,Bucket,12").issues[0].field).toBe("alt_unit");
  });

  it("rejects missing required columns, unknown columns and empty files", () => {
    expect(analyse("name\nPump").issues).toEqual([{ row: 1, field: "sku", message: 'The "sku" column is required' }]);
    expect(analyse("sku,name,saleprice\nA1,Pump,5").issues[0]).toMatchObject({ row: 1, field: "saleprice" });
    expect(analyse("sku,name").issues[0].message).toContain("no product rows");
  });

  it("limits the number of rows", () => {
    const records = Array.from({ length: maxImportRows + 1 }, (_, index) => ({ sku: `S${index}`, name: `N${index}` }));
    const result = analyseProductImport(["sku", "name"], records, lookups());
    expect(result.issues[0].message).toContain(String(maxImportRows));
    expect(result.products).toEqual([]);
  });

  it("analyses 500 valid rows quickly", () => {
    const records = Array.from({ length: 500 }, (_, index) => ({
      sku: `SKU-${index}`, name: `Product ${index}`, sale_price: "10.50", cost: "7", barcode: `89640${String(index).padStart(8, "0")}`,
    }));
    const started = performance.now();
    const result = analyseProductImport(["sku", "name", "sale_price", "cost", "barcode"], records, lookups());
    expect(result.issues).toEqual([]);
    expect(result.variantsToCreate).toBe(500);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
