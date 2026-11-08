import { formatBps, formatPkr } from "./money";
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

export type ReceiptModel = {
  title: string;
  duplicateBanner: string | null;
  businessName: string;
  headerLines: string[];
  number: string;
  dateText: string;
  cashier: string;
  terminal: string;
  lines: ReceiptLine[];
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

export function buildReceipt(invoice: ReceiptInvoice, format: PrintFormat, options: ReceiptOptions): ReceiptModel {
  const { business } = options;
  const sheet = format === "a4" || format === "a5";
  const lineDiscount = invoice.lineDiscountPaisa;
  const billDiscount = invoice.invoiceDiscountPaisa;

  const taxByRate = new Map<number, { taxable: number; tax: number }>();
  for (const line of invoice.lines) {
    const entry = taxByRate.get(line.taxRateBps) ?? { taxable: 0, tax: 0 };
    entry.taxable += line.totalPaisa - line.taxPaisa;
    entry.tax += line.taxPaisa;
    taxByRate.set(line.taxRateBps, entry);
  }

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

  const registration = [business.ntn ? `NTN ${business.ntn}` : "", business.strn ? `STRN ${business.strn}` : ""].filter(Boolean).join("  ");
  return {
    title: sheet ? "SALES INVOICE" : "SALES RECEIPT",
    duplicateBanner: options.duplicate ? `DUPLICATE — copy ${options.duplicate.copyNumber}, not the original` : null,
    businessName: business.tradeName,
    headerLines: [invoice.branchName !== business.tradeName ? invoice.branchName : "", business.address, business.phone && `Tel ${business.phone}`, registration].filter((line): line is string => Boolean(line)),
    number: invoice.number,
    dateText: formatDocumentDate(invoice.postedAt, options.dateFormat, options.timezone),
    cashier: invoice.cashierName ?? "",
    terminal: invoice.terminalName,
    lines: invoice.lines.map((line) => {
      const discount = line.lineDiscountPaisa + line.invoiceDiscountSharePaisa;
      return {
        name: line.variantName ? `${line.productName} — ${line.variantName}` : line.productName,
        detail: `${line.sku} · ${line.unitName}${line.taxRateBps ? ` · tax ${formatBps(line.taxRateBps)}%` : ""}`,
        quantity: formatQuantity(parseQuantity(line.quantity)),
        unitPrice: formatPkr(line.unitPricePaisa),
        discount: discount > 0 ? negative(discount) : null,
        total: formatPkr(line.totalPaisa),
      };
    }),
    totals,
    taxRows: [...taxByRate.entries()].sort(([a], [b]) => a - b).map(([rate, entry]) => ({ rate: `${formatBps(rate)}%`, taxable: formatPkr(entry.taxable), tax: formatPkr(entry.tax) })),
    payments,
    footer: business.receiptFooter ? business.receiptFooter.split(/\r?\n/).filter(Boolean) : ["Thank you for shopping with us."],
  };
}
