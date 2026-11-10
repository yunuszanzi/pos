// @vitest-environment node
import { describe, expect, it } from "vitest";
import { app } from "../../server/app";
import { callApi, createSimpleProduct, createTestBusiness, hasLocalStack, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);
const key = () => `key-${crypto.randomUUID()}`;

// v1.0 performance at the SRS targets, on a real database holding 20,000 SKUs (NFR-PRF-01, NFR-PRF-02):
//   - a product search or barcode lookup on the server answers in under 300 ms;
//   - a sale (post + stock + ledger) completes in under 1.5 s, excluding FBR;
//   - the stock list and a report over the whole catalogue answer in a few seconds.
// The calls run in-process against the local database, so network time is not included; the till searches on the device anyway
// (tests/unit/performance.test.ts), and these are the slow paths: the back office and the final posting.

const SKUS = 20_000;
const p95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)];
const timed = async <T>(work: () => Promise<T>) => { const start = performance.now(); const result = await work(); return { result, ms: performance.now() - start }; };

integration("20,000 SKUs on a real database", { timeout: 600_000 }, () => {
  it("searches in under 300 ms and posts a sale in under 1.5 s", async () => {
    const business = await createTestBusiness();
    const seed = await createSimpleProduct(business, "SEED", 100);
    const database = sql();
    try {
      await database`
        with s as (select n, gen_random_uuid() as pid, gen_random_uuid() as vid from generate_series(1, ${SKUS}) n),
        p as (insert into products (id, business_id, name, base_unit_id) select pid, ${business.businessId}::uuid, 'Balloon ' || n, ${seed.pieceId}::uuid from s returning id),
        v as (insert into product_variants (id, business_id, product_id, sku, cost_paisa) select vid, ${business.businessId}::uuid, pid, 'PERF-' || lpad(n::text, 6, '0'), 100 from s returning id)
        insert into product_units (business_id, variant_id, unit_id, factor_to_base, is_base, barcode, sale_price_paisa)
        select ${business.businessId}::uuid, vid, ${seed.pieceId}::uuid, 1, true, '890' || lpad(n::text, 9, '0'), 500 from s`;
      await database`analyze products`;
      await database`analyze product_variants`;
      await database`analyze product_units`;
      const [{ count }] = await database<{ count: string }[]>`select count(*)::text as count from product_variants where business_id = ${business.businessId}`;
      expect(Number(count)).toBe(SKUS + 1);
    } finally {
      await database.end();
    }

    // Product search by name, SKU and barcode.
    const searches = ["Balloon 12345", "PERF-012345", "890000012345", "balloon 19", "PERF-0199", "zzz-nothing"];
    const searchTimes: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      for (const q of searches) {
        const { result, ms } = await timed(() => callApi(business.ownerToken, "GET", `/products?q=${encodeURIComponent(q)}&pageSize=20`));
        expect(result.status, q).toBe(200);
        searchTimes.push(ms);
      }
    }
    const found = await callApi(business.ownerToken, "GET", `/products?q=${encodeURIComponent("PERF-012345")}&pageSize=20`);
    expect(found.body.data.map((row: { name: string }) => row.name)).toEqual(["Balloon 12345"]);
    expect(p95(searchTimes), `search times ms: ${searchTimes.map((t) => t.toFixed(0)).join(",")}`).toBeLessThan(300);

    // A page of the catalogue, the stock list and the delta sync the tills use.
    const list = await timed(() => callApi(business.ownerToken, "GET", "/products?pageSize=100&page=100"));
    expect(list.result.status).toBe(200);
    expect(list.ms).toBeLessThan(1000);
    const stock = await timed(() => callApi(business.ownerToken, "GET", "/stock?pageSize=100"));
    expect(stock.result.status).toBe(200);
    expect(stock.ms).toBeLessThan(2000);
    const delta = await timed(() => callApi(business.ownerToken, "GET", "/pos/products/changes?since=0"));
    expect(delta.result.status).toBe(200);
    expect(delta.ms).toBeLessThan(3000);

    // Sales on a catalogue this size.
    const opening = await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nSEED,100000,Piece,1.00" }, idempotencyKey: key() });
    expect(opening.status).toBe(201);
    const as = { terminalId: business.terminalId };
    const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const client = sql();
    const [cash] = await client<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'cash'`;
    await client.end();
    const saleTimes: number[] = [];
    for (let n = 0; n < 20; n += 1) {
      const { result, ms } = await timed(() => callApi(business.ownerToken, "POST", "/sales", {
        ...as, idempotencyKey: key(),
        body: { shiftId: shift.body.id, lines: [{ variantId: seed.variantId, unitId: seed.pieceId, quantity: "2" }, { variantId: seed.variantId, unitId: seed.cartonId, quantity: "1" }], payments: [{ methodId: cash.id, amountPaisa: 100_000 }] },
      }));
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      saleTimes.push(ms);
    }
    expect(p95(saleTimes), `sale times ms: ${saleTimes.map((t) => t.toFixed(0)).join(",")}`).toBeLessThan(1500);
  });
});

integration("reports over 100,000 invoice lines (NFR-PRF-03)", { timeout: 900_000 }, () => {
  it("run in under 10 s, and a large export too", async () => {
    const business = await createTestBusiness();
    const seed = await createSimpleProduct(business, "SEED", 100);
    expect((await callApi(business.ownerToken, "POST", "/stock/opening", { body: { csv: "sku,quantity,unit,cost\nSEED,1000,Piece,1.00" }, idempotencyKey: key() })).status).toBe(201);
    const as = { terminalId: business.terminalId };
    const shift = await callApi(business.ownerToken, "POST", "/shifts/open", { ...as, body: { openingFloatPaisa: 0 }, idempotencyKey: key() });
    const database = sql();
    try {
      const [cash] = await database<{ id: string }[]>`SELECT id FROM payment_methods WHERE business_id = ${business.businessId} AND code = 'cash'`;
      const sale = await callApi(business.ownerToken, "POST", "/sales", {
        ...as, idempotencyKey: key(), body: { shiftId: shift.body.id, lines: [{ variantId: seed.variantId, unitId: seed.pieceId, quantity: "2" }], payments: [{ methodId: cash.id, amountPaisa: 1000 }] },
      });
      expect(sale.status).toBe(201);
      // 5,000 invoices of 20 lines each, copies of that one sale spread over the last 90 days, each line a different product.
      await database`
        create temp table clone_ids as select n, gen_random_uuid() as id from generate_series(1, 5000) n`;
      await database`
        insert into sales_invoices
        select (jsonb_populate_record(null::sales_invoices, to_jsonb(i) || jsonb_build_object(
          'id', c.id, 'number', 'CLONE-' || c.n, 'sequence_no', 100000 + c.n, 'posted_at', now() - make_interval(days => (c.n % 90)::int, hours => (c.n % 12)::int)))).*
        from sales_invoices i cross join clone_ids c where i.id = ${sale.body.invoice.id}`;
      await database`
        insert into sales_invoice_lines
        select (jsonb_populate_record(null::sales_invoice_lines, to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'invoice_id', c.id, 'line_no', k))).*
        from sales_invoice_lines l cross join clone_ids c cross join generate_series(1, 20) k where l.invoice_id = ${sale.body.invoice.id}`;
      await database`analyze sales_invoices`;
      await database`analyze sales_invoice_lines`;
      const [{ lines }] = await database<{ lines: string }[]>`select count(*)::text as lines from sales_invoice_lines where business_id = ${business.businessId}`;
      expect(Number(lines)).toBeGreaterThanOrEqual(100_000);
    } finally {
      await database.end();
    }

    const keys = ["sales-summary", "sales-by-product", "sales-by-category", "sales-by-customer", "sales-by-cashier", "invoice-register", "discounts", "profit-by-invoice", "profit-by-product", "profit-and-loss", "sales-tax-summary", "payments-by-method"];
    const known = new Set((await callApi(business.ownerToken, "GET", "/report-catalogue")).body.data.map((report: { key: string }) => report.key));
    const slow: string[] = [];
    let ran = 0;
    for (const reportKey of keys.filter((entry) => known.has(entry))) {
      const { result, ms } = await timed(() => callApi(business.ownerToken, "GET", `/report-data/${reportKey}?from=2020-01-01&to=2029-12-31`));
      expect(result.status, `${reportKey}: ${JSON.stringify(result.body).slice(0, 200)}`).toBe(200);
      ran += 1;
      if (ms >= 10_000) slow.push(`${reportKey} ${ms.toFixed(0)} ms`);
    }
    expect(ran).toBeGreaterThanOrEqual(8);
    expect(slow).toEqual([]);

    // A large export is built within the same limit (larger ones become background jobs, NFR-PRF-03).
    const exported = await timed(async () => {
      const response = await app.fetch(new Request("http://localhost/api/v1/report-data/invoice-register?from=2020-01-01&to=2029-12-31&format=csv", { headers: { Authorization: `Bearer ${business.ownerToken}` } }));
      return { status: response.status, text: await response.text() };
    });
    expect(exported.result.status).toBe(200);
    expect(exported.result.text.split(String.fromCharCode(10)).length).toBeGreaterThan(5000);
    expect(exported.ms).toBeLessThan(10_000);
  });
});
