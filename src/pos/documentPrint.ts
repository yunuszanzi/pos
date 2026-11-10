import type { ReceiptDeliveryChallan, ReceiptInvoice, ReceiptQuotation, ReceiptSalesOrder } from "../../shared/receipt";
import type { Challan } from "../api/deliveryApi";
import type { Quotation } from "../api/quotationsApi";
import type { SalesOrder } from "../api/salesOrdersApi";
import type { Invoice } from "../api/salesInvoicesApi";

// What each back-office document prints. The pages print their own document with these, and a shared link shows the same thing, so
// what a customer sees on their phone is exactly what comes off the printer.

type Sheet = ReceiptInvoice["lines"];

const sheetLines = (lines: Array<{
  productName: string; variantName: string; sku: string; unitName: string; quantity: string; unitPricePaisa: number; lineDiscountPaisa: number;
  invoiceDiscountSharePaisa: number; taxRateBps: number; taxPaisa: number; totalPaisa: number;
}>): Sheet => lines.map((line) => ({
  productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity, unitPricePaisa: line.unitPricePaisa,
  lineDiscountPaisa: line.lineDiscountPaisa, invoiceDiscountSharePaisa: line.invoiceDiscountSharePaisa, taxRateBps: line.taxRateBps, taxPaisa: line.taxPaisa, totalPaisa: line.totalPaisa,
}));

export const quotationPrintDoc = (data: Quotation): ReceiptQuotation => ({
  number: data.number, revisionNo: data.revisionNo, quoteDate: data.quoteDate, validUntil: data.validUntil, branchName: data.branchName,
  customerName: data.customerName, customerPhone: data.customerPhone, customerNtn: data.customerNtn, customerStrn: data.customerStrn,
  terms: data.terms, note: data.note, taxMode: data.taxMode, grossPaisa: data.grossPaisa, lineDiscountPaisa: data.lineDiscountPaisa,
  invoiceDiscountPaisa: data.invoiceDiscountPaisa, taxPaisa: data.taxPaisa, roundingPaisa: data.roundingPaisa, totalPaisa: data.totalPaisa,
  lines: sheetLines(data.lines),
});

export const salesOrderPrintDoc = (data: SalesOrder): ReceiptSalesOrder => ({
  number: data.number, orderDate: data.orderDate, deliveryDate: data.deliveryDate, branchName: data.branchName, customerName: data.customerName, customerPhone: data.customerPhone,
  customerNtn: data.customerNtn, customerStrn: data.customerStrn, customerPo: data.customerPo, quotationNumber: data.quotationNumber, deliveryAddress: data.deliveryAddress,
  note: data.note, taxMode: data.taxMode, grossPaisa: data.grossPaisa, lineDiscountPaisa: data.lineDiscountPaisa, invoiceDiscountPaisa: data.invoiceDiscountPaisa,
  taxPaisa: data.taxPaisa, roundingPaisa: data.roundingPaisa, totalPaisa: data.totalPaisa,
  lines: sheetLines(data.lines),
});

export const challanPrintDoc = (data: Challan): ReceiptDeliveryChallan => ({
  number: data.number, at: data.dispatchedAt ?? data.createdAt, branchName: data.branchName, customerName: data.customerName, customerPhone: data.customerPhone,
  orderNumber: data.orderNumber, customerPo: data.customerPo, driverName: data.driverName, vehicleNo: data.vehicleNo, route: data.route,
  deliveryAddress: data.deliveryAddress, note: data.note,
  lines: data.lines.map((line) => ({ productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity })),
});

export const invoicePrintDoc = (data: Invoice): ReceiptInvoice => ({
  number: data.number, postedAt: data.postedAt, cashierName: data.cashierName, terminalName: data.terminalName, branchName: data.branchName, taxMode: data.taxMode,
  grossPaisa: data.grossPaisa, lineDiscountPaisa: data.lineDiscountPaisa, invoiceDiscountPaisa: data.invoiceDiscountPaisa, taxPaisa: data.taxPaisa, roundingPaisa: data.roundingPaisa,
  totalPaisa: data.totalPaisa, paidPaisa: data.paidPaisa, changePaisa: data.changePaisa, balancePaisa: data.balancePaisa,
  customerName: data.customerName, customerBalancePaisa: null,
  channel: data.channel, termsDays: data.termsDays, dueDate: data.dueDate, customerPo: data.customerPo, orderNumber: data.orderNumber, note: data.note,
  buyerName: data.buyerName, buyerNtn: data.buyerNtn, buyerStrn: data.buyerStrn, buyerAddress: data.buyerAddress,
  fbrStatus: data.fbrStatus, fbrIrn: data.fbrIrn, fbrQr: data.fbrQr,
  lines: sheetLines(data.lines),
  payments: [],
});
