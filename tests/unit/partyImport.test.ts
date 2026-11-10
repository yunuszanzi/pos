import { describe, expect, it } from "vitest";
import { csvToRecords, parseCsv } from "../../shared/csv";
import { analyseParties, customerImportColumns, customerTemplateRows, supplierTemplateRows, type PartyLookups } from "../../shared/partyImport";
import { toCsv } from "../../shared/csv";

const none: PartyLookups = { names: new Set(), cnics: new Set(), namePhones: new Set() };
const read = (text: string) => csvToRecords(parseCsv(text));
const customers = (text: string, lookups = none) => { const { headers, records } = read(text); return analyseParties("customer", headers, records, lookups); };
const suppliers = (text: string, lookups = none) => { const { headers, records } = read(text); return analyseParties("supplier", headers, records, lookups); };

describe("importing customers", () => {
  it("accepts the template as it is given out", () => {
    const result = customers(toCsv(customerTemplateRows));
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].input).toMatchObject({ name: "Bilal Wholesale", businessName: "Bilal Traders", cnic: "4210112345671", registered: false, creditLimitPaisa: 5_000_000, termsDays: 15 });
  });

  it("turns rupees into whole paisa and yes/no into true/false", () => {
    const result = customers("name,credit_limit,registered,terms_days\nA,1250.5,Yes,30\nB,,,\nC,\"1,000\",n,0");
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => [row.input.creditLimitPaisa, row.input.registered, row.input.termsDays])).toEqual([[125_050, true, 30], [0, false, 0], [100_000, false, 0]]);
  });

  it("names every problem by row and column, and imports nothing if there is one", () => {
    const result = customers("name,phone,cnic,registered,credit_limit,terms_days,email\n,0301-1,42101-1234567-1,maybe,12.345,x,not-an-email\nOk One,abc,123,,,,");
    const found = result.issues.map((issue) => `${issue.row}:${issue.field}`).sort();
    expect(found).toEqual(expect.arrayContaining(["2:name", "2:registered", "2:credit_limit", "2:terms_days", "2:email", "3:phone", "3:cnic"]));
    expect(result.rows).toEqual([]);
  });

  it("refuses a missing name column, unknown columns, an empty file and a file that is too large", () => {
    expect(customers("phone\n0301").issues[0]).toMatchObject({ row: 1, field: "name" });
    expect(customers("name,favourite_colour\nA,blue").issues.map((issue) => issue.field)).toContain("favourite_colour");
    expect(customers("name").issues[0].message).toMatch(/no rows/);
    const big = `name\n${Array.from({ length: 5001 }, (_, index) => `C${index}`).join("\n")}`;
    expect(customers(big).issues[0].message).toMatch(/At most 5000/);
  });

  it("catches a customer already held (by CNIC, or by name and phone) and a repeat inside the file", () => {
    const lookups: PartyLookups = { names: new Set(), cnics: new Set(["4210112345671"]), namePhones: new Set(["asif|03011111111"]) };
    const held = customers("name,phone,cnic\nNew,0300,42101-1234567-1\nAsif,0301-1111111,\nFresh,0302,", lookups);
    expect(held.issues.map((issue) => `${issue.row}:${issue.field}`)).toEqual(["2:cnic", "3:name"]);
    const twice = customers("name,phone,cnic\nA,1111111,35202-1111111-1\nB,2222222,35202-1111111-1\nC,3333333,\nc,3333333,");
    expect(twice.issues.map((issue) => `${issue.row}:${issue.field}`)).toEqual(["3:cnic", "5:name"]);
    // Two people with the same name but different phones are two customers.
    expect(customers("name,phone\nAsif,1111111\nAsif,2222222").issues).toEqual([]);
  });
});

describe("importing suppliers", () => {
  it("accepts the template", () => {
    const result = suppliers(toCsv(supplierTemplateRows));
    expect(result.issues).toEqual([]);
    expect(result.rows[0].input).toMatchObject({ name: "Karachi Balloon Mills", contactPerson: "Imran", registered: true, termsDays: 30 });
  });
  it("rejects a name already used, ignoring case and spaces, and a repeat in the file", () => {
    const lookups: PartyLookups = { names: new Set(["karachi balloon mills"]), cnics: new Set(), namePhones: new Set() };
    expect(suppliers("name\n Karachi Balloon Mills \nOther\nother", lookups).issues.map((issue) => `${issue.row}:${issue.field}`)).toEqual(["2:name", "4:name"]);
  });
  it("does not take customer columns", () => {
    expect(suppliers("name,credit_limit\nA,10").issues.map((issue) => issue.field)).toContain("credit_limit");
    expect(customerImportColumns).toContain("credit_limit");
  });
});
