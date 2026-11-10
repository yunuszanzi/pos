import { discountsOverLimit } from "../../shared/pricing";
import type { Settlement } from "../../shared/payments";
import { formatQuantity } from "../../shared/units";
import type { SaleInvoice } from "../api/posApi";
import type { Cart, CartTotals } from "./cart";

/**
 * The bill as the till can write it without the server: from the cart and the same pricing engine the server uses. It is what the
 * offline slip shows. It carries the slip reference where the invoice number will be, and the number the books give it follows
 * once the sale is sent.
 */
export function buildOfflineInvoice(input: {
  offlineRef: string;
  soldAt: string;
  cart: Cart;
  totals: CartTotals;
  taxMode: "inclusive" | "exclusive";
  branchName: string;
  terminalName: string;
  cashierName: string | null;
  shiftId: string;
  customer: { id: string; name: string; balancePaisa: number } | null;
  settlement: Settlement;
  payments: Array<{ methodCode: string; methodName: string; reference: string }>;
}): SaleInvoice {
  const { totals, settlement } = input;
  const priced = totals.priced;
  return {
    id: `offline:${input.offlineRef}`,
    number: input.offlineRef,
    offlineRef: input.offlineRef,
    postedAt: input.soldAt,
    branchName: input.branchName,
    terminalName: input.terminalName,
    cashierName: input.cashierName,
    shiftId: input.shiftId,
    customerId: input.customer?.id ?? null,
    customerName: input.customer?.name ?? null,
    customerBalancePaisa: input.customer ? input.customer.balancePaisa : null,
    taxMode: input.taxMode,
    grossPaisa: priced.grossPaisa,
    lineDiscountPaisa: priced.lineDiscountPaisa,
    invoiceDiscountPaisa: priced.invoiceDiscountPaisa,
    taxablePaisa: priced.taxablePaisa,
    taxPaisa: priced.taxPaisa,
    roundingPaisa: priced.roundingPaisa,
    totalPaisa: priced.totalPaisa,
    paidPaisa: settlement.paidPaisa,
    changePaisa: settlement.changePaisa,
    balancePaisa: settlement.balancePaisa,
    lines: totals.lines.map(({ line, entry, unitPricePaisa }, index) => {
      const out = priced.lines[index];
      return {
        lineNo: index + 1, variantId: entry.variantId, unitId: entry.unitId, productName: entry.productName, variantName: entry.variantName, sku: entry.sku, unitName: entry.unitName,
        hsCode: null, quantity: formatQuantity(line.quantityMilli), unitPricePaisa, grossPaisa: out.grossPaisa, lineDiscountPaisa: out.lineDiscountPaisa,
        invoiceDiscountSharePaisa: out.invoiceDiscountSharePaisa, netPaisa: out.netPaisa, taxRateBps: entry.taxRateBps, taxPaisa: out.taxPaisa, totalPaisa: out.totalPaisa, returnedQuantity: "0",
      };
    }),
    payments: input.payments.map((payment, index) => ({
      methodCode: payment.methodCode, methodName: payment.methodName, amountPaisa: settlement.tenders[index].appliedPaisa,
      tenderedPaisa: settlement.tenders[index].tenderedPaisa, changePaisa: settlement.tenders[index].changePaisa, reference: payment.reference,
    })),
  };
}

/**
 * Why this sale cannot be taken while offline, or null if it can. Two things need a person or a record the till cannot reach without a
 * connection: credit (the customer's balance and limit live on the server) and a discount above the cashier's limit (a manager's PIN is
 * checked on the server). Everything else is posted when it is sent, and flagged if it turned out wrong.
 */
export function whyNotOffline(input: { cart: Cart; totals: CartTotals; onAccountPaisa: number; maxDiscountBps: number; mayDiscountAboveLimit: boolean }): string | null {
  if (input.onAccountPaisa > 0) return "There is no connection, so a sale on account cannot be taken. Take full payment, or wait until the connection is back.";
  const hasDiscount = Boolean(input.cart.invoiceDiscount) || input.cart.lines.some((line) => line.discount);
  if (hasDiscount && !input.mayDiscountAboveLimit) {
    const lines = input.totals.lines.map(({ line, entry, unitPricePaisa }) => ({ qtyMilli: line.quantityMilli, unitPricePaisa, taxRateBps: entry.taxRateBps, discount: line.discount }));
    const breaches = discountsOverLimit({ lines, invoiceDiscount: input.cart.invoiceDiscount, taxMode: "inclusive" }, input.totals.priced, input.maxDiscountBps);
    if (breaches.length) return "There is no connection, so a manager cannot approve this discount. Reduce the discount, or wait until the connection is back.";
  }
  return null;
}
