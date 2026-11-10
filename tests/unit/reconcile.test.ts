import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The restore drill is only worth anything if the comparison catches a difference. This runs the real script on two small fingerprints.

const folder = mkdtempSync(join(tmpdir(), "reconcile-"));
const write = (name: string, value: unknown) => { const file = join(folder, name); writeFileSync(file, JSON.stringify(value)); return file; };
const compare = (a: string, b: string) => spawnSync(process.execPath, ["scripts/reconcile.mjs", "--compare", a, b], { encoding: "utf8" });

const original = { totals: { shopA: { invoices: 10, salesPaisa: "125000", customerBalancePaisa: "40000" } }, tables: { sales_invoices: { rows: 10, checksum: "abc" }, payments: { rows: 12, checksum: "def" } } };

describe("comparing a restored database with its original", () => {
  it("says MATCH for identical fingerprints", () => {
    const result = compare(write("a.json", original), write("b.json", structuredClone(original)));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MATCH");
  });

  it("fails and names the figure when a total differs", () => {
    const changed = structuredClone(original);
    changed.totals.shopA.salesPaisa = "124999";
    const result = compare(write("c.json", original), write("d.json", changed));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("totals.shopA.salesPaisa".replace("totals.", ""));
    expect(result.stderr).toContain('"125000" <> "124999"');
  });

  it("fails when a row was lost, or changed without changing the count", () => {
    const lost = structuredClone(original);
    lost.tables.sales_invoices.rows = 9;
    const changedRow = structuredClone(original);
    changedRow.tables.payments.checksum = "xyz";
    expect(compare(write("e.json", original), write("f.json", lost)).status).toBe(1);
    const result = compare(write("g.json", original), write("h.json", changedRow));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tables.payments.checksum");
  });

  it("fails when a business is missing from the restored copy", () => {
    const missing = { totals: {}, tables: original.tables };
    expect(compare(write("i.json", original), write("j.json", missing)).status).toBe(1);
  });

  it("compares totals alone when a fingerprint is taken as of a time", () => {
    const asOf = { totals: original.totals };
    expect(compare(write("k.json", asOf), write("l.json", structuredClone(asOf))).stdout).toContain("totals identical");
  });
});
