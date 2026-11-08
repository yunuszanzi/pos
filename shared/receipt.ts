import { formatBps, formatPkr } from "./money";
import type { StatementSummary } from "./khata";
import { formatQuantity, parseQuantity } from "./units";

// What goes on a printed sales document (FR-PRT). One model feeds every format; the format only decides the paper and the layout.

export const printFormats = ["pos80", "pos58", "a4", "a5"] as const;
export type PrintFormat = (typeof printFormats)[number];

export const printFormatLabels: Record<PrintFormat, string> = {
  pos80: "POS slip 80 mm",
  pos58: "POS slip 58 mm",
  a4: "A4 invoice",
  a5: "A5 invoice",
};

/** Slips are as long as they need to be; sheets are a fixed size. */
export function receiptPageCss(format: PrintFormat): string {
  switch (format) {
    case "pos80": return "@page { size: 80mm auto; margin: 3mm; }";
    case "pos58": return "@page { size: 58mm auto; margin: 2mm; }";
    case "a4": return "@page { size: A4; margin: 12mm; }";
    case "a5": return "@page { size: A5; margin: 10mm; }";
  }
}

export type ReceiptInvoice = {
  number: string;
  postedAt: string;
  cashierName: string | null;
  terminalName: string;
  branchName: string;
  taxMode: "inclusive" | "exclusive";
  grossPaisa: number;
  lineDiscountPaisa: number;
  invoiceDiscountPaisa: number;
  taxPaisa: number;
  roundingPaisa: number;
  totalPaisa: number;
  paidPaisa: number;
  changePaisa: number;
  balancePaisa: number;
  /** Set when the sale was to a named customer. The balance is what they owed straight after this invoice. */
  customerName?: string | null;
  customerBalancePaisa?: number | null;
  lines: Array<{
    productName: string; variantName: string; sku: string; unitName: string; quantity: string; unitPricePaisa: number;
    lineDiscountPaisa: number; invoiceDiscountSharePaisa: number; taxRateBps: number; taxPaisa: number; totalPaisa: number;
  }>;
  payments: Array<{ methodName: string; amountPaisa: number; tenderedPaisa: number; changePaisa: number; reference: string }>;
};

export type ReceiptBusiness = {
  tradeName: string; legalName: string; address: string; phone: string; ntn: string | null; strn: string | null; receiptFooter: string;
};

export type ReceiptOptions = {
  business: ReceiptBusiness;
  dateFormat: string;
  timezone: string;
  /** Set for a reprint. The copy is marked DUPLICATE so it cannot pass for the original. */
  duplicate?: { copyNumber: number };
};

export type ReceiptLine = { name: string; detail: string; quantity: string; unitPrice: string; discount: string | null; total: string };
export type ReceiptRow = { label: string; value: string; strong?: boolean };
export type ReceiptStatementRow = { date: string; document: string; memo: string; debit: string; credit: string; balance: string };

export type ReceiptModel = {
  title: string;
  duplicateBanner: string | null;
  businessName: string;
  headerLines: string[];
  number: string;
  dateText: string;
  cashier: string;
  terminal: string;
  /** The named customer, or null for a walk-in. */
  customer: string | null;
  /** The small facts under the heading (number, date, who, where), in the order they print. */
  meta: ReceiptRow[];
  lines: ReceiptLine[];
  /** A statement of account lists ledger entries instead of items. */
  statementRows?: ReceiptStatementRow[];
  totals: ReceiptRow[];
  /** Tax by rate, for the buyer and the tax office. */
  taxRows: Array<{ rate: string; taxable: string; tax: string }>;
  payments: ReceiptRow[];
  footer: string[];
};

/** "08/11/2026 14:35" in the business's time zone and date style. */
export function formatDocumentDate(iso: string, dateFormat: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const [day, month, year] = [part("day"), part("month"), part("year")];
  const date = dateFormat === "MM/dd/yyyy" ? `${month}/${day}/${year}` : dateFormat === "yyyy-MM-dd" ? `${year}-${month}-${day}` : `${day}/${month}/${year}`;
  return `${date} ${part("hour")}:${part("minute")}`;
}

const negative = (paisa: number) => `-${formatPkr(paisa)}`;

const duplicateBanner = (options: ReceiptOptions) => (options.duplicate ? `DUPLICATE — copy ${options.duplicate.copyNumber}, not the original` : null);

function headerLinesOf(business: ReceiptBusiness, branchName: string): string[] {
  const registration = [business.ntn ? `NTN ${business.ntn}` : "", business.strn ? `STRN ${business.strn}` : ""].filter(Boolean).join("  ");
  return [branchName !== business.tradeName ? branchName : "", business.address, business.phone && `Tel ${business.phone}`, registration].filter((line): line is string => Boolean(line));
}

type DocumentLine = ReceiptInvoice["lines"][number];

/** Tax by rate, for the buyer and the tax office. */
function taxRowsOf(lines: DocumentLine[]): ReceiptModel["taxRows"] {
  const taxByRate = new Map<number, { taxable: number; tax: number }>();
  for (const line of lines) {
    const entry = taxByRate.get(line.taxRateBps) ?? { taxable: 0, tax: 0 };
    entry.taxable += line.totalPaisa - line.taxPaisa;
    entry.tax += line.taxPaisa;
    taxByRate.set(line.taxRateBps, entry);
  }
  return [...taxByRate.entries()].sort(([a], [b]) => a - b).map(([rate, entry]) => ({ rate: `${formatBps(rate)}%`, taxable: formatPkr(entry.taxable), tax: formatPkr(entry.tax) }));
}

function lineRowsOf<T extends DocumentLine>(lines: T[], detailExtra: (line: T) => string = () => ""): ReceiptLine[] {
  return lines.map((line) => {
    const discount = line.lineDiscountPaisa + line.invoiceDiscountSharePaisa;
    return {
      name: line.variantName ? `${line.productName} — ${line.variantName}` : line.productName,
      detail: `${line.sku} · ${line.unitName}${line.taxRateBps ? ` · tax ${formatBps(line.taxRateBps)}%` : ""}${detailExtra(line)}`,
      quantity: formatQuantity(parseQuantity(line.quantity)),
      unitPrice: formatPkr(line.unitPricePaisa),
      discount: discount > 0 ? negative(discount) : null,
      total: formatPkr(line.totalPaisa),
    };
  });
}

export function buildReceipt(invoice: ReceiptInvoice, format: PrintFormat, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const sheet = format === "a4" || format === "a5";
  const lineDiscount = invoice.lineDiscountPaisa;
  const billDiscount = invoice.invoiceDiscountPaisa;

  const totals: ReceiptRow[] = [{ label: "Subtotal", value: formatPkr(invoice.grossPaisa) }];
  if (lineDiscount > 0) totals.push({ label: "Item discounts", value: negative(lineDiscount) });
  if (billDiscount > 0) totals.push({ label: "Bill discount", value: negative(billDiscount) });
  totals.push({ label: invoice.taxMode === "inclusive" ? "Tax (included)" : "Tax", value: formatPkr(invoice.taxPaisa) });
  if (invoice.roundingPaisa !== 0) totals.push({ label: "Rounding", value: invoice.roundingPaisa < 0 ? negative(-invoice.roundingPaisa) : formatPkr(invoice.roundingPaisa) });
  totals.push({ label: "TOTAL", value: formatPkr(invoice.totalPaisa), strong: true });

  const payments: ReceiptRow[] = invoice.payments.map((payment) => ({
    label: payment.reference ? `${payment.methodName} (${payment.reference})` : payment.methodName,
    value: formatPkr(payment.tenderedPaisa),
  }));
  if (invoice.changePaisa > 0) payments.push({ label: "Change", value: formatPkr(invoice.changePaisa), strong: true });
  if (invoice.balancePaisa > 0) payments.push({ label: "Balance due", value: formatPkr(invoice.balancePaisa), strong: true });
  if (invoice.customerName && typeof invoice.customerBalancePaisa === "number") {
    const owed = invoice.customerBalancePaisa;
    payments.push(owed < 0
      ? { label: "Credit on account", value: formatPkr(-owed) }
      : { label: "Account balance (khata)", value: formatPkr(owed) });
  }

  const dateText = formatDocumentDate(invoice.postedAt, options.dateFormat, options.timezone);
  return {
    title: sheet ? "SALES INVOICE" : "SALES RECEIPT",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, invoice.branchName),
    number: invoice.number,
    dateText,
    cashier: invoice.cashierName ?? "",
    terminal: invoice.terminalName,
    customer: invoice.customerName || null,
    meta: [
      { label: "No.", value: invoice.number }, { label: "Date", value: dateText }, { label: "Cashier", value: invoice.cashierName ?? "" },
      { label: "Till", value: invoice.terminalName }, ...(invoice.customerName ? [{ label: "Customer", value: invoice.customerName }] : []),
    ],
    lines: lineRowsOf(invoice.lines),
    totals,
    taxRows: taxRowsOf(invoice.lines),
    payments,
    footer: business.receiptFooter ? business.receiptFooter.split(/\r?\n/).filter(Boolean) : ["Thank you for shopping with us."],
  };
}

/** Money received from a customer against their khata. */
export type ReceiptPayment = {
  number: string;
  postedAt: string;
  receivedBy: string | null;
  branchName: string;
  customerName: string;
  methodName: string;
  amountPaisa: number;
  reference: string;
  note: string;
  /** The invoices it settled. Whatever is left over stays on the account. */
  allocations: Array<{ number: string; amountPaisa: number }>;
  /** What the customer owes now (negative: they hold credit). */
  customerBalancePaisa: number;
};

export function buildPaymentReceipt(payment: ReceiptPayment, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const dateText = formatDocumentDate(payment.postedAt, options.dateFormat, options.timezone);
  const allocated = payment.allocations.reduce((sum, row) => sum + row.amountPaisa, 0);
  const rows: ReceiptRow[] = payment.allocations.map((row) => ({ label: `Against ${row.number}`, value: formatPkr(row.amountPaisa) }));
  if (payment.amountPaisa > allocated) rows.push({ label: "On account", value: formatPkr(payment.amountPaisa - allocated) });
  rows.push(payment.customerBalancePaisa < 0
    ? { label: "Credit on account", value: formatPkr(-payment.customerBalancePaisa), strong: true }
    : { label: "Balance still owed", value: formatPkr(payment.customerBalancePaisa), strong: true });
  return {
    title: "PAYMENT RECEIPT",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, payment.branchName),
    number: payment.number,
    dateText,
    cashier: payment.receivedBy ?? "",
    terminal: payment.branchName,
    customer: payment.customerName,
    meta: [
      { label: "No.", value: payment.number }, { label: "Date", value: dateText }, { label: "Customer", value: payment.customerName },
      ...(payment.receivedBy ? [{ label: "Received by", value: payment.receivedBy }] : []),
    ],
    lines: [],
    totals: [
      { label: payment.reference ? `${payment.methodName} (${payment.reference})` : payment.methodName, value: formatPkr(payment.amountPaisa) },
      { label: "RECEIVED", value: formatPkr(payment.amountPaisa), strong: true },
    ],
    taxRows: [],
    payments: rows,
    footer: payment.note ? [payment.note, "Thank you."] : ["Thank you."],
  };
}

/** Goods taken back against an invoice (or, with approval, without one). */
export type ReceiptCreditNote = {
  number: string;
  postedAt: string;
  cashierName: string | null;
  terminalName: string;
  branchName: string;
  taxMode: "inclusive" | "exclusive";
  invoiceNumber: string | null;
  customerName: string | null;
  /** What the customer owed straight after this return (negative: they hold store credit). */
  customerBalancePaisa: number | null;
  reason: string;
  grossPaisa: number;
  lineDiscountPaisa: number;
  invoiceDiscountPaisa: number;
  taxPaisa: number;
  roundingPaisa: number;
  totalPaisa: number;
  refundMethodName: string | null;
  refundPaisa: number;
  refundReference: string;
  accountCreditPaisa: number;
  lines: Array<DocumentLine & { restockTo: "sellable" | "damaged" | "write_off" }>;
};

const restockNotes = { sellable: "", damaged: " · damaged", write_off: " · written off" } as const;

export function buildCreditNoteReceipt(note: ReceiptCreditNote, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const totals: ReceiptRow[] = [{ label: "Subtotal", value: formatPkr(note.grossPaisa) }];
  if (note.lineDiscountPaisa > 0) totals.push({ label: "Item discounts", value: negative(note.lineDiscountPaisa) });
  if (note.invoiceDiscountPaisa > 0) totals.push({ label: "Bill discount", value: negative(note.invoiceDiscountPaisa) });
  totals.push({ label: note.taxMode === "inclusive" ? "Tax (included)" : "Tax", value: formatPkr(note.taxPaisa) });
  if (note.roundingPaisa !== 0) totals.push({ label: "Rounding", value: note.roundingPaisa < 0 ? negative(-note.roundingPaisa) : formatPkr(note.roundingPaisa) });
  totals.push({ label: "CREDIT TOTAL", value: formatPkr(note.totalPaisa), strong: true });

  const payments: ReceiptRow[] = [];
  if (note.refundPaisa > 0) {
    const how = note.refundMethodName ? `Refunded — ${note.refundMethodName}${note.refundReference ? ` (${note.refundReference})` : ""}` : "Refunded";
    payments.push({ label: how, value: formatPkr(note.refundPaisa), strong: true });
  }
  if (note.accountCreditPaisa > 0) payments.push({ label: "Credited to account", value: formatPkr(note.accountCreditPaisa), strong: true });
  if (note.customerName && typeof note.customerBalancePaisa === "number") {
    payments.push(note.customerBalancePaisa < 0
      ? { label: "Credit on account", value: formatPkr(-note.customerBalancePaisa) }
      : { label: "Account balance (khata)", value: formatPkr(note.customerBalancePaisa) });
  }

  const dateText = formatDocumentDate(note.postedAt, options.dateFormat, options.timezone);
  return {
    title: "CREDIT NOTE",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, note.branchName),
    number: note.number,
    dateText,
    cashier: note.cashierName ?? "",
    terminal: note.terminalName,
    customer: note.customerName || null,
    meta: [
      { label: "No.", value: note.number }, { label: "Date", value: dateText },
      { label: "Invoice", value: note.invoiceNumber ?? "none (no receipt)" },
      { label: "Cashier", value: note.cashierName ?? "" }, { label: "Till", value: note.terminalName },
      ...(note.customerName ? [{ label: "Customer", value: note.customerName }] : []),
      ...(note.reason ? [{ label: "Reason", value: note.reason }] : []),
    ],
    lines: lineRowsOf(note.lines, (line) => restockNotes[line.restockTo]),
    totals,
    taxRows: taxRowsOf(note.lines),
    payments,
    footer: business.receiptFooter ? business.receiptFooter.split(/\r?\n/).filter(Boolean) : ["Thank you."],
  };
}

// ---------------------------------------------------------------- customer statement

export type ReceiptStatement = {
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  /** yyyy-mm-dd, the first and last day on the statement. */
  from: string;
  to: string;
  summary: StatementSummary;
  entries: Array<{ at: string; docNumber: string; memo: string; debitPaisa: number; creditPaisa: number; balanceAfterPaisa: number }>;
};

/** A balance as a statement shows it: what is owed, or "Cr" when the customer holds credit. */
const balanceText = (paisa: number) => (paisa < 0 ? `${formatPkr(-paisa)} Cr` : formatPkr(paisa));

export function buildStatementReceipt(statement: ReceiptStatement, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const { summary } = statement;
  const period = `${statement.from} to ${statement.to}`;
  const rows: ReceiptRow[] = [
    { label: "Opening balance", value: balanceText(summary.openingPaisa) },
    { label: "Invoices", value: formatPkr(summary.invoicesPaisa) },
    { label: "Payments received", value: negative(summary.paymentsPaisa) },
    { label: "Returns", value: negative(summary.returnsPaisa) },
  ];
  if (summary.refundsPaisa) rows.push({ label: "Refunds paid out", value: formatPkr(summary.refundsPaisa) });
  if (summary.otherPaisa) rows.push({ label: "Opening balance / adjustments", value: summary.otherPaisa < 0 ? negative(-summary.otherPaisa) : formatPkr(summary.otherPaisa) });
  rows.push({ label: summary.closingPaisa < 0 ? "CREDIT WITH US" : "BALANCE DUE", value: formatPkr(Math.abs(summary.closingPaisa)), strong: true });
  return {
    title: "STATEMENT OF ACCOUNT",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, business.tradeName),
    number: period,
    dateText: period,
    cashier: "",
    terminal: "",
    customer: statement.customerName,
    meta: [
      { label: "Customer", value: statement.customerName },
      ...(statement.customerPhone ? [{ label: "Phone", value: statement.customerPhone }] : []),
      ...(statement.customerAddress ? [{ label: "Address", value: statement.customerAddress }] : []),
      { label: "Period", value: period },
    ],
    lines: [],
    statementRows: statement.entries.map((entry) => ({
      date: formatDocumentDate(entry.at, options.dateFormat, options.timezone).split(" ")[0],
      document: entry.docNumber,
      memo: entry.memo,
      debit: entry.debitPaisa ? formatPkr(entry.debitPaisa) : "",
      credit: entry.creditPaisa ? formatPkr(entry.creditPaisa) : "",
      balance: balanceText(entry.balanceAfterPaisa),
    })),
    totals: rows,
    taxRows: [],
    payments: [],
    footer: business.receiptFooter ? [business.receiptFooter] : ["Please tell us if anything on this statement looks wrong."],
  };
}

// ---------------------------------------------------------------- purchase documents

/** "2026-11-09" in the business's date style. A day with no time of day, so no time zone applies. */
export function formatDay(day: string, dateFormat: string): string {
  const [year, month, date] = day.split("-");
  return dateFormat === "MM/dd/yyyy" ? `${month}/${date}/${year}` : dateFormat === "yyyy-MM-dd" ? `${year}-${month}-${date}` : `${date}/${month}/${year}`;
}

type PurchaseLine = {
  productName: string; variantName: string; sku: string; unitName: string; quantity: string;
  /** Left out for people who may not see costs. */
  unitCostPaisa?: number; lineTotalPaisa?: number;
};

export type ReceiptPurchaseOrder = {
  number: string;
  /** yyyy-mm-dd */
  orderDate: string;
  expectedDate: string | null;
  supplierName: string;
  branchName: string;
  locationName: string;
  note: string;
  totalPaisa?: number;
  lines: PurchaseLine[];
};

function purchaseLineRows(lines: PurchaseLine[]): ReceiptLine[] {
  return lines.map((line) => ({
    name: line.variantName ? `${line.productName} — ${line.variantName}` : line.productName,
    detail: `${line.sku} · ${line.unitName}`,
    quantity: formatQuantity(parseQuantity(line.quantity)),
    unitPrice: line.unitCostPaisa === undefined ? "" : formatPkr(line.unitCostPaisa),
    discount: null,
    total: line.lineTotalPaisa === undefined ? "" : formatPkr(line.lineTotalPaisa),
  }));
}

export function buildPurchaseOrderReceipt(order: ReceiptPurchaseOrder, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const dateText = formatDay(order.orderDate, options.dateFormat);
  return {
    title: "PURCHASE ORDER",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, order.branchName),
    number: order.number,
    dateText,
    cashier: "",
    terminal: "",
    customer: null,
    meta: [
      { label: "No.", value: order.number }, { label: "Date", value: dateText }, { label: "To", value: order.supplierName },
      ...(order.expectedDate ? [{ label: "Expected", value: formatDay(order.expectedDate, options.dateFormat) }] : []),
      { label: "Deliver to", value: order.locationName },
    ],
    lines: purchaseLineRows(order.lines),
    totals: order.totalPaisa === undefined ? [] : [{ label: "ORDER TOTAL", value: formatPkr(order.totalPaisa), strong: true }],
    taxRows: [],
    payments: [],
    footer: order.note ? [order.note] : [],
  };
}

export type ReceiptGoodsReceipt = {
  number: string;
  receivedAt: string;
  supplierName: string;
  branchName: string;
  locationName: string;
  orderNumber: string | null;
  supplierRef: string;
  receivedBy: string | null;
  note: string;
  totalPaisa?: number;
  lines: PurchaseLine[];
};

export function buildGoodsReceiptReceipt(receipt: ReceiptGoodsReceipt, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const dateText = formatDocumentDate(receipt.receivedAt, options.dateFormat, options.timezone);
  return {
    title: "GOODS RECEIVED",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, receipt.branchName),
    number: receipt.number,
    dateText,
    cashier: receipt.receivedBy ?? "",
    terminal: "",
    customer: null,
    meta: [
      { label: "No.", value: receipt.number }, { label: "Date", value: dateText }, { label: "From", value: receipt.supplierName },
      ...(receipt.orderNumber ? [{ label: "Order", value: receipt.orderNumber }] : []),
      ...(receipt.supplierRef ? [{ label: "Supplier ref", value: receipt.supplierRef }] : []),
      { label: "Into", value: receipt.locationName },
      ...(receipt.receivedBy ? [{ label: "Received by", value: receipt.receivedBy }] : []),
    ],
    lines: purchaseLineRows(receipt.lines),
    totals: receipt.totalPaisa === undefined ? [] : [{ label: "VALUE RECEIVED", value: formatPkr(receipt.totalPaisa), strong: true }],
    taxRows: [],
    payments: [],
    footer: receipt.note ? [receipt.note] : [],
  };
}

export type ReceiptPurchaseBill = {
  /** The shop's own number for the bill. */
  number: string;
  supplierInvoiceNo: string;
  supplierName: string;
  branchName: string;
  /** yyyy-mm-dd */
  billDate: string;
  dueDate: string;
  note: string;
  subtotalPaisa: number;
  chargesPaisa: number;
  taxPaisa: number;
  totalPaisa: number;
  lines: Array<{ productName: string; variantName: string; sku: string; unitName: string; quantity: string; unitCostPaisa: number; lineValuePaisa: number }>;
  charges: Array<{ description: string; amountPaisa: number }>;
};

/** The shop's record of a supplier's bill: what was billed, the freight and tax on it, and when it is due. */
export function buildPurchaseBillReceipt(bill: ReceiptPurchaseBill, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const dateText = formatDay(bill.billDate, options.dateFormat);
  return {
    title: "SUPPLIER BILL",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, bill.branchName),
    number: bill.number,
    dateText,
    cashier: "",
    terminal: "",
    customer: null,
    meta: [
      { label: "No.", value: bill.number }, { label: "Supplier", value: bill.supplierName }, { label: "Their invoice", value: bill.supplierInvoiceNo },
      { label: "Date", value: dateText }, { label: "Due", value: formatDay(bill.dueDate, options.dateFormat) },
    ],
    lines: purchaseLineRows(bill.lines.map((line) => ({ ...line, lineTotalPaisa: line.lineValuePaisa }))),
    totals: [
      { label: "Items", value: formatPkr(bill.subtotalPaisa) },
      ...bill.charges.map((charge) => ({ label: charge.description, value: formatPkr(charge.amountPaisa) })),
      ...(bill.taxPaisa ? [{ label: "Input tax", value: formatPkr(bill.taxPaisa) }] : []),
      { label: "BILL TOTAL", value: formatPkr(bill.totalPaisa), strong: true },
    ],
    taxRows: [],
    payments: [],
    footer: bill.note ? [bill.note] : [],
  };
}

export type ReceiptSupplierPayment = {
  number: string;
  postedAt: string;
  paidBy: string | null;
  branchName: string;
  supplierName: string;
  methodName: string;
  amountPaisa: number;
  reference: string;
  note: string;
  /** The bills it settled. Whatever is left over is an advance with the supplier. */
  allocations: Array<{ number: string; supplierInvoiceNo: string; amountPaisa: number }>;
  /** What the shop owes the supplier now (negative: the supplier holds the shop's advance). */
  supplierBalancePaisa: number;
};

/** The voucher for money paid to a supplier. */
export function buildSupplierPaymentReceipt(payment: ReceiptSupplierPayment, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const dateText = formatDocumentDate(payment.postedAt, options.dateFormat, options.timezone);
  const allocated = payment.allocations.reduce((sum, row) => sum + row.amountPaisa, 0);
  const rows: ReceiptRow[] = payment.allocations.map((row) => ({ label: `Against ${row.supplierInvoiceNo} (${row.number})`, value: formatPkr(row.amountPaisa) }));
  if (payment.amountPaisa > allocated) rows.push({ label: "Advance (not against a bill)", value: formatPkr(payment.amountPaisa - allocated) });
  rows.push(payment.supplierBalancePaisa < 0
    ? { label: "Advance held with supplier", value: formatPkr(-payment.supplierBalancePaisa), strong: true }
    : { label: "Still owed to supplier", value: formatPkr(payment.supplierBalancePaisa), strong: true });
  return {
    title: "PAYMENT VOUCHER",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, payment.branchName),
    number: payment.number,
    dateText,
    cashier: payment.paidBy ?? "",
    terminal: "",
    customer: null,
    meta: [
      { label: "No.", value: payment.number }, { label: "Date", value: dateText }, { label: "Paid to", value: payment.supplierName },
      ...(payment.paidBy ? [{ label: "Paid by", value: payment.paidBy }] : []),
    ],
    lines: [],
    totals: [
      { label: payment.reference ? `${payment.methodName} (${payment.reference})` : payment.methodName, value: formatPkr(payment.amountPaisa) },
      { label: "PAID", value: formatPkr(payment.amountPaisa), strong: true },
    ],
    taxRows: [],
    payments: rows,
    footer: payment.note ? [payment.note] : [],
  };
}

export type ReceiptPurchaseReturn = {
  number: string;
  postedAt: string;
  supplierName: string;
  branchName: string;
  receiptNumber: string;
  reason: string;
  subtotalPaisa: number;
  taxPaisa: number;
  totalPaisa: number;
  settledBillsPaisa: number;
  onAccountPaisa: number;
  lines: Array<{ productName: string; variantName: string; sku: string; unitName: string; quantity: string; unitCostPaisa: number; lineValuePaisa: number }>;
};

/** The debit note for goods sent back to a supplier. */
export function buildPurchaseReturnReceipt(note: ReceiptPurchaseReturn, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const dateText = formatDocumentDate(note.postedAt, options.dateFormat, options.timezone);
  return {
    title: "DEBIT NOTE",
    duplicateBanner: duplicateBanner(options),
    businessName: business.tradeName,
    headerLines: headerLinesOf(business, note.branchName),
    number: note.number,
    dateText,
    cashier: "",
    terminal: "",
    customer: null,
    meta: [
      { label: "No.", value: note.number }, { label: "Date", value: dateText }, { label: "To", value: note.supplierName }, { label: "Goods receipt", value: note.receiptNumber },
      ...(note.reason ? [{ label: "Reason", value: note.reason }] : []),
    ],
    lines: purchaseLineRows(note.lines.map((line) => ({ ...line, lineTotalPaisa: line.lineValuePaisa }))),
    totals: [
      { label: "Goods returned", value: formatPkr(note.subtotalPaisa) },
      ...(note.taxPaisa ? [{ label: "Input tax reversed", value: formatPkr(note.taxPaisa) }] : []),
      { label: "DEBIT TOTAL", value: formatPkr(note.totalPaisa), strong: true },
    ],
    taxRows: [],
    payments: [
      ...(note.settledBillsPaisa ? [{ label: "Taken off bills", value: formatPkr(note.settledBillsPaisa) }] : []),
      ...(note.onAccountPaisa ? [{ label: "Credit on account", value: formatPkr(note.onAccountPaisa) }] : []),
    ],
    footer: [],
  };
}
