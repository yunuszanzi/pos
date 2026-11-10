import { describe, expect, it } from "vitest";
import { ageLedger, reminderMessage, summariseStatement, whatsappLink, whatsappNumber, whatsappShareLink, type KhataEntry } from "../../shared/khata";
import { analyseOpeningBalances, type OpeningBalanceLookups } from "../../shared/openingBalanceImport";

const entry = (docType: string, debitPaisa: number, creditPaisa: number, at: string): KhataEntry => ({ docType, debitPaisa, creditPaisa, at });

describe("statement summary", () => {
  it("closing balance = opening + invoices − payments − returns + refunds", () => {
    const summary = summariseStatement(10_000, [
      entry("sales_invoice", 50_000, 0, "2026-10-02T08:00:00Z"),
      entry("sales_invoice", 0, 20_000, "2026-10-02T08:00:00Z"), // paid at the till
      entry("customer_payment", 0, 5_000, "2026-10-10T08:00:00Z"),
      entry("sales_return", 0, 12_000, "2026-10-12T08:00:00Z"),
      entry("sales_return", 4_000, 0, "2026-10-12T08:00:00Z"), // refunded
    ]);
    expect(summary).toEqual({
      openingPaisa: 10_000, invoicesPaisa: 50_000, paymentsPaisa: 25_000, returnsPaisa: 12_000, refundsPaisa: 4_000, otherPaisa: 0,
      closingPaisa: 10_000 + 50_000 - 25_000 - 12_000 + 4_000,
    });
  });

  it("carries opening balances and adjustments as 'other'", () => {
    const summary = summariseStatement(0, [entry("opening_balance", 7_000, 0, "2026-10-01T00:00:00Z"), entry("adjustment", 0, 1_000, "2026-10-02T00:00:00Z")]);
    expect(summary.otherPaisa).toBe(6_000);
    expect(summary.closingPaisa).toBe(6_000);
  });

  it("counts a bounced cheque as a payment taken back", () => {
    const summary = summariseStatement(0, [
      entry("sales_invoice", 10_000, 0, "2026-10-02T08:00:00Z"),
      entry("customer_payment", 0, 10_000, "2026-10-03T08:00:00Z"),
      entry("cheque_bounce", 10_000, 0, "2026-10-20T08:00:00Z"),
    ]);
    expect(summary).toMatchObject({ invoicesPaisa: 10_000, paymentsPaisa: 0, closingPaisa: 10_000 });
  });

  it("is just the opening balance when nothing happened", () => {
    expect(summariseStatement(-300, []).closingPaisa).toBe(-300);
  });
});

describe("ageing", () => {
  const asOf = new Date("2026-11-09T12:00:00Z");
  const daysAgo = (days: number) => new Date(asOf.getTime() - days * 86_400_000).toISOString();

  it("puts each unpaid invoice in the band for its age", () => {
    const ageing = ageLedger([
      entry("sales_invoice", 1_000, 0, daysAgo(100)),
      entry("sales_invoice", 2_000, 0, daysAgo(75)),
      entry("sales_invoice", 4_000, 0, daysAgo(45)),
      entry("sales_invoice", 8_000, 0, daysAgo(30)),
      entry("sales_invoice", 16_000, 0, daysAgo(0)),
    ], asOf);
    expect(ageing.bandsPaisa).toEqual([24_000, 4_000, 2_000, 1_000]);
    expect(ageing.owedPaisa).toBe(31_000);
    expect(ageing.oldestDays).toBe(100);
  });

  it("applies payments to the oldest debt first", () => {
    const ageing = ageLedger([
      entry("sales_invoice", 10_000, 0, daysAgo(80)),
      entry("sales_invoice", 10_000, 0, daysAgo(10)),
      entry("customer_payment", 0, 12_000, daysAgo(5)),
    ], asOf);
    expect(ageing.bandsPaisa).toEqual([8_000, 0, 0, 0]);
    expect(ageing.oldestDays).toBe(10);
  });

  it("does not count a refunded return as new debt", () => {
    const ageing = ageLedger([
      entry("sales_invoice", 5_000, 0, daysAgo(2)),
      entry("sales_invoice", 0, 5_000, daysAgo(2)), // paid in full
      entry("sales_return", 0, 5_000, daysAgo(1)), // returned: store credit for a moment
      entry("sales_return", 5_000, 0, daysAgo(1)), // refunded in cash
    ], asOf);
    expect(ageing.owedPaisa).toBe(0);
    expect(ageing.creditPaisa).toBe(0);
  });

  it("keeps unspent credit apart from what is owed, and the two net to the balance", () => {
    const ageing = ageLedger([entry("sales_invoice", 3_000, 0, daysAgo(40)), entry("customer_payment", 0, 5_000, daysAgo(1))], asOf);
    expect(ageing.owedPaisa).toBe(0);
    expect(ageing.creditPaisa).toBe(2_000);
    const mixed = ageLedger([entry("customer_payment", 0, 2_000, daysAgo(9)), entry("sales_invoice", 3_000, 0, daysAgo(3))], asOf);
    expect(mixed.owedPaisa).toBe(1_000);
    expect(mixed.creditPaisa).toBe(0);
  });

  it("owed − credit always equals the ledger balance", () => {
    const entries = [
      entry("opening_balance", 9_000, 0, daysAgo(120)), entry("sales_invoice", 4_000, 0, daysAgo(50)), entry("customer_payment", 0, 3_000, daysAgo(40)),
      entry("sales_return", 0, 2_000, daysAgo(20)), entry("sales_invoice", 1_500, 0, daysAgo(7)),
    ];
    const ageing = ageLedger(entries, asOf);
    const balance = entries.reduce((sum, row) => sum + row.debitPaisa - row.creditPaisa, 0);
    expect(ageing.owedPaisa - ageing.creditPaisa).toBe(balance);
  });
});

describe("WhatsApp", () => {
  it("turns local numbers into international ones", () => {
    expect(whatsappNumber("0300-1234567")).toBe("923001234567");
    expect(whatsappNumber("+92 300 1234567")).toBe("923001234567");
    expect(whatsappNumber("00923001234567")).toBe("923001234567");
    expect(whatsappNumber("300 1234567")).toBe("923001234567");
    expect(whatsappNumber("021-34567890")).toBe("922134567890");
  });

  it("refuses what cannot be a number", () => {
    expect(whatsappNumber("")).toBeNull();
    expect(whatsappNumber("12345")).toBeNull();
    expect(whatsappLink("abc", "hi")).toBeNull();
  });

  it("builds a link with no number, to choose who to send to", () => {
    expect(whatsappShareLink("Low: A & B\n- 5")).toBe("https://wa.me/?text=Low%3A%20A%20%26%20B%0A-%205");
  });

  it("builds a link with the message encoded", () => {
    const link = whatsappLink("03001234567", reminderMessage({ customerName: "Ali & Sons", businessName: "SGA Balloons", balancePaisa: 123_456 }));
    expect(link?.startsWith("https://wa.me/923001234567?text=")).toBe(true);
    expect(decodeURIComponent(link!.split("?text=")[1])).toContain("Rs 1,234.56");
    expect(link).not.toContain("&Sons");
  });
});

describe("opening balance import", () => {
  const lookups: OpeningBalanceLookups = {
    idsByName: new Map([["ali traders", ["c1"]], ["bilal", ["c2", "c3"]], ["sara", ["c4"]]]),
    idsByPhone: new Map([["923001234567", ["c1"]], ["923111111111", ["c5"]]]),
    withEntries: new Set(["c4"]),
    today: "2026-11-09",
  };
  const run = (rows: Array<Record<string, string>>, headers = ["customer", "phone", "balance", "date", "note"]) => analyseOpeningBalances(headers, rows, lookups);

  it("loads owed and credit balances, matching by name or phone", () => {
    const result = run([
      { customer: "Ali Traders", phone: "", balance: "45,000.00", date: "2026-10-31", note: "old register" },
      { customer: "", phone: "0311-1111111", balance: "-1200.50", date: "", note: "" },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.lines).toEqual([
      { row: 2, customerId: "c1", amountPaisa: 4_500_000, asOf: "2026-10-31", note: "old register" },
      { row: 3, customerId: "c5", amountPaisa: -120_050, asOf: "2026-11-09", note: "" },
    ]);
    expect(result.owedPaisa).toBe(4_500_000);
    expect(result.creditPaisa).toBe(120_050);
  });

  it("reports every problem with its row", () => {
    const result = run([
      { customer: "Nobody", phone: "", balance: "10", date: "", note: "" },
      { customer: "Bilal", phone: "", balance: "10", date: "", note: "" },
      { customer: "Sara", phone: "", balance: "10", date: "", note: "" },
      { customer: "Ali Traders", phone: "", balance: "0", date: "", note: "" },
      { customer: "Ali Traders", phone: "", balance: "ten", date: "", note: "" },
      { customer: "Ali Traders", phone: "", balance: "5.001", date: "", note: "" },
      { customer: "Ali Traders", phone: "", balance: "5", date: "31-10-2026", note: "" },
      { customer: "Ali Traders", phone: "", balance: "5", date: "2026-12-01", note: "" },
      { customer: "", phone: "", balance: "5", date: "", note: "" },
    ]);
    expect(result.lines).toEqual([]);
    expect(result.issues.map((issue) => [issue.row, issue.field])).toEqual([
      [2, "customer"], [3, "customer"], [4, "customer"], [5, "balance"], [6, "balance"], [7, "balance"], [8, "date"], [9, "date"], [10, "customer"],
    ]);
  });

  it("flags a customer who appears twice", () => {
    const result = run([{ customer: "Ali Traders", phone: "", balance: "5", date: "", note: "" }, { customer: "", phone: "03001234567", balance: "6", date: "", note: "" }]);
    expect(result.issues).toMatchObject([{ row: 3, field: "customer" }]);
  });

  it("checks the file's columns", () => {
    expect(analyseOpeningBalances(["customer"], [{ customer: "x" }], lookups).issues[0].field).toBe("balance");
    expect(analyseOpeningBalances(["balance"], [{ balance: "1" }], lookups).issues[0].field).toBe("customer");
    expect(analyseOpeningBalances(["customer", "balance", "colour"], [{ customer: "x", balance: "1" }], lookups).issues[0].field).toBe("colour");
    expect(analyseOpeningBalances(["customer", "balance"], [], lookups).issues[0].field).toBe("file");
  });
});
