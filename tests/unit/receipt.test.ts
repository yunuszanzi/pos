import { describe, expect, it } from "vitest";
import { buildReceipt, formatDocumentDate, receiptPageCss, type ReceiptBusiness, type ReceiptInvoice } from "../../shared/receipt";

const business: ReceiptBusiness = {
  tradeName: "SGA Balloons", legalName: "SGA Balloons (Pvt) Ltd", address: "Shop 4, Saddar, Karachi", phone: "021-111", ntn: "1234567-8", strn: null, receiptFooter: "",
};
const options = { business, dateFormat: "dd/MM/yyyy", timezone: "Asia/Karachi" };

const invoice: ReceiptInvoice = {
  number: "INV-KHI-000042",
  postedAt: "2026-11-08T09:35:00.000Z", // 14:35 in Karachi (UTC+5)
  cashierName: "Ayesha", terminalName: "Register 1", branchName: "Main Branch", taxMode: "inclusive",
  grossPaisa: 5000, lineDiscountPaisa: 0, invoiceDiscountPaisa: 250, taxPaisa: 724, roundingPaisa: -5, totalPaisa: 4745, paidPaisa: 4745, changePaisa: 255, balancePaisa: 0,
  lines: [
    { productName: "Red Balloon", variantName: "", sku: "BAL-RED", unitName: "Pack", quantity: "2.000", unitPricePaisa: 1500, lineDiscountPaisa: 0, invoiceDiscountSharePaisa: 100, taxRateBps: 1800, taxPaisa: 442, totalPaisa: 2900 },
    { productName: "Ribbon", variantName: "Gold", sku: "RIB-G", unitName: "Piece", quantity: "4", unitPricePaisa: 500, lineDiscountPaisa: 0, invoiceDiscountSharePaisa: 150, taxRateBps: 0, taxPaisa: 0, totalPaisa: 1850 },
  ],
  payments: [
    { methodName: "Cash", amountPaisa: 2745, tenderedPaisa: 3000, changePaisa: 255, reference: "" },
    { methodName: "JazzCash", amountPaisa: 2000, tenderedPaisa: 2000, changePaisa: 0, reference: "JC-9" },
  ],
};

describe("receipt page css", () => {
  it("sets the paper for each format", () => {
    expect(receiptPageCss("pos80")).toContain("80mm auto");
    expect(receiptPageCss("pos58")).toContain("58mm auto");
    expect(receiptPageCss("a4")).toContain("size: A4");
    expect(receiptPageCss("a5")).toContain("size: A5");
  });
});

describe("document dates", () => {
  it("shows the business's local time, not the browser's", () => {
    expect(formatDocumentDate(invoice.postedAt, "dd/MM/yyyy", "Asia/Karachi")).toBe("08/11/2026 14:35");
    expect(formatDocumentDate(invoice.postedAt, "MM/dd/yyyy", "Asia/Karachi")).toBe("11/08/2026 14:35");
    expect(formatDocumentDate(invoice.postedAt, "yyyy-MM-dd", "Asia/Karachi")).toBe("2026-11-08 14:35");
    expect(formatDocumentDate("2026-11-08T20:30:00.000Z", "dd/MM/yyyy", "Asia/Karachi")).toBe("09/11/2026 01:30");
  });
});

describe("receipt model", () => {
  const model = buildReceipt(invoice, "pos80", options);

  it("carries the identity, number and who rang it up", () => {
    expect(model).toMatchObject({ title: "SALES RECEIPT", number: "INV-KHI-000042", dateText: "08/11/2026 14:35", cashier: "Ayesha", terminal: "Register 1", duplicateBanner: null });
    expect(model.headerLines).toEqual(["Main Branch", "Shop 4, Saddar, Karachi", "Tel 021-111", "NTN 1234567-8"]);
  });

  it("lists lines with exact quantities, shares of the bill discount and money to 2 decimals", () => {
    expect(model.lines[0]).toEqual({ name: "Red Balloon", detail: "BAL-RED · Pack · tax 18%", quantity: "2", unitPrice: "Rs 15.00", discount: "-Rs 1.00", total: "Rs 29.00" });
    expect(model.lines[1]).toMatchObject({ name: "Ribbon — Gold", quantity: "4", discount: "-Rs 1.50", detail: "RIB-G · Piece" });
  });

  it("shows the totals in order, with discounts, tax, rounding and the total last", () => {
    expect(model.totals).toEqual([
      { label: "Subtotal", value: "Rs 50.00" },
      { label: "Bill discount", value: "-Rs 2.50" },
      { label: "Tax (included)", value: "Rs 7.24" },
      { label: "Rounding", value: "-Rs 0.05" },
      { label: "TOTAL", value: "Rs 47.45", strong: true },
    ]);
  });

  it("shows what was handed over for each method, references, and the change", () => {
    expect(model.payments).toEqual([
      { label: "Cash", value: "Rs 30.00" },
      { label: "JazzCash (JC-9)", value: "Rs 20.00" },
      { label: "Change", value: "Rs 2.55", strong: true },
    ]);
  });

  it("summarises tax by rate", () => {
    expect(model.taxRows).toEqual([
      { rate: "0%", taxable: "Rs 18.50", tax: "Rs 0.00" },
      { rate: "18%", taxable: "Rs 24.58", tax: "Rs 4.42" },
    ]);
  });

  it("marks a reprint as a duplicate, and sheets as invoices", () => {
    const copy = buildReceipt(invoice, "a4", { ...options, duplicate: { copyNumber: 2 } });
    expect(copy.duplicateBanner).toBe("DUPLICATE — copy 2, not the original");
    expect(copy.title).toBe("SALES INVOICE");
    expect(copy.number).toBe(model.number);
    expect(copy.totals).toEqual(model.totals);
  });

  it("uses the shop's footer when it has one, and says what is still owed", () => {
    const owed = buildReceipt({ ...invoice, balancePaisa: 500, changePaisa: 0 }, "pos58", { business: { ...business, receiptFooter: "No returns without receipt\nWelcome again" }, dateFormat: "dd/MM/yyyy", timezone: "Asia/Karachi" });
    expect(owed.footer).toEqual(["No returns without receipt", "Welcome again"]);
    expect(owed.payments.at(-1)).toEqual({ label: "Balance due", value: "Rs 5.00", strong: true });
    expect(model.footer).toEqual(["Thank you for shopping with us."]);
  });
});
