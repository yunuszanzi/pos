import { useRef, useState, type FormEvent } from "react";
import { formatPkr, toPlainRupees } from "../../shared/money";
import { PaymentError, settleTenders, type Tender } from "../../shared/payments";
import { ApiRequestError, NetworkError } from "../api/client";
import { postSaleInvoice, type PostedSale } from "../api/posApi";
import { ErrorMessage, Field, SelectInput, TextInput } from "../app/FormElements";
import { MoneyInput } from "../app/MoneyInput";
import { amountOf } from "./amounts";
import { toSaleRequest, type Cart, type CartTotals } from "./cart";
import { useCartStore } from "./cartStore";
import { Dialog } from "./Dialog";
import { buildOfflineInvoice, whyNotOffline } from "./offlineSale";
import { usePos } from "./pos-context";
import { parseSignedQuantity, formatQuantity } from "../../shared/units";

type Row = { id: string; methodId: string; amount: string; reference: string };

/**
 * Takes the money: one or several payment methods, change for cash, a manager's PIN when a discount is above the cashier's limit.
 * Pressing Pay sends one request; the checkout key keeps a repeat press, or a retry after a lost reply, from posting a second bill.
 */
export function PaymentDialog({ cart, totals, totalPaisa, onClose, onPaid }: { cart: Cart; totals: CartTotals; totalPaisa: number; onClose: () => void; onPaid: (sale: PostedSale) => void }) {
  const { data, shift, applyStock, syncNow, customers, rememberCustomer, offline, can, stockOnHand } = usePos();
  const customer = cart.customerId ? customers.get(cart.customerId) : undefined;
  const methods = data.paymentMethods;
  const cash = methods.find((method) => method.kind === "cash") ?? methods[0];
  const [rows, setRows] = useState<Row[]>([{ id: crypto.randomUUID(), methodId: cash.id, amount: toPlainRupees(totalPaisa), reference: "" }]);
  const [error, setError] = useState("");
  const [needsManager, setNeedsManager] = useState(false);
  const [manager, setManager] = useState({ email: "", pin: "" });
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  const kindOf = (methodId: string) => methods.find((method) => method.id === methodId)?.kind;
  const amounts = rows.map((row) => amountOf(row.amount));
  const complete = amounts.every((amount) => amount !== null && amount > 0);

  let change = 0;
  let remaining = totalPaisa;
  let problem = "";
  if (complete) {
    const tenders: Tender[] = rows.map((row, index) => ({ kind: kindOf(row.methodId) === "cash" ? "cash" : "other", amountPaisa: amounts[index]! }));
    try {
      const settlement = settleTenders(totalPaisa, tenders);
      change = settlement.changePaisa;
      remaining = settlement.balancePaisa;
    } catch (caught) {
      problem = caught instanceof PaymentError ? caught.message : "Check the payments";
    }
  } else {
    remaining = totalPaisa - amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
  }
  // A named customer may leave the rest on their account (khata); a walk-in pays in full.
  const onAccount = customer && complete && !problem && remaining > 0 ? remaining : 0;
  const canPay = complete && !problem && (remaining === 0 || onAccount > 0) && !busy;

  function setRow(id: string, change: Partial<Row>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
  }

  function addRow() {
    const left = Math.max(remaining, 0);
    const other = methods.find((method) => method.kind !== "cash") ?? methods[0];
    setRows((current) => [...current, { id: crypto.randomUUID(), methodId: other.id, amount: left > 0 ? toPlainRupees(left) : "", reference: "" }]);
  }

  /**
   * No connection: the sale is kept on this device and sent when it returns. The customer is served now; the slip says it is not yet in
   * the books. The request is the very one that would have been sent, with the same key, so a sale that did reach the server before the
   * reply was lost is recognised and not posted twice.
   */
  async function takeOffline(request: ReturnType<typeof toSaleRequest>, key: string) {
    const reason = whyNotOffline({ cart, totals, onAccountPaisa: onAccount, maxDiscountBps: data.user.maxDiscountBps, mayDiscountAboveLimit: can("sales.discount.above_limit") });
    if (reason) throw new Error(reason);
    const tenders: Tender[] = rows.map((row, index) => ({ kind: kindOf(row.methodId) === "cash" ? "cash" : "other", amountPaisa: amounts[index]! }));
    const settlement = settleTenders(totalPaisa, tenders);
    const soldAt = new Date().toISOString();
    const reference = await offline.nextReference();
    const invoice = buildOfflineInvoice({
      offlineRef: reference, soldAt, cart, totals, taxMode: data.settings.taxMode, branchName: data.branch.name, terminalName: data.terminal.name,
      cashierName: data.user.name, shiftId: shift!.id, customer: customer ? { id: customer.id, name: customer.name, balancePaisa: customer.balancePaisa } : null, settlement,
      payments: rows.map((row) => { const method = methods.find((entry) => entry.id === row.methodId)!; return { methodCode: method.code, methodName: method.name, reference: row.reference }; }),
    });
    await offline.save({ offlineRef: reference, idempotencyKey: key, terminalId: data.terminal.id, soldAt, request, invoice });
    // What is on the shelf, as far as this till knows, drops by what was sold.
    applyStock(totals.lines.filter(({ entry }) => entry.productType === "stocked").map(({ line, entry }) => {
      const sold = Math.round((line.quantityMilli * entry.factorToBaseMilli) / 1000);
      const left = parseSignedQuantity(stockOnHand.get(entry.variantId) ?? "0") - sold;
      return { variantId: entry.variantId, onHand: `${left < 0 ? "-" : ""}${formatQuantity(Math.abs(left))}` };
    }));
    onPaid({ invoice, stock: [], offline: { reference, flags: [] } });
  }

  async function pay(event?: FormEvent) {
    event?.preventDefault();
    if (!canPay || sending.current || !shift) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const key = useCartStore.getState().beginCheckout();
      const request = toSaleRequest(cart, shift.id, rows.map((row, index) => ({ methodId: row.methodId, amountPaisa: amounts[index]!, reference: row.reference })), {
        expectedTotalPaisa: totalPaisa,
        ...(needsManager && manager.email ? { approval: { managerEmail: manager.email.trim(), pin: manager.pin } } : {}),
      });
      // With no connection at all there is nothing to wait for: keep the sale on the device and carry on.
      if (!offline.online) {
        await takeOffline(request, key);
        return;
      }
      let sale: PostedSale;
      try {
        sale = await postSaleInvoice(request, key);
      } catch (caught) {
        // The server could not be reached; it may or may not have seen the request. Same key, so it is never posted twice.
        if (!(caught instanceof NetworkError)) throw caught;
        offline.markUnreachable();
        await takeOffline(request, key);
        return;
      }
      applyStock(sale.stock);
      // The response carries the customer's new balance, so the till does not ask for it again.
      if (customer && sale.invoice.customerBalancePaisa !== null) rememberCustomer({ ...customer, balancePaisa: sale.invoice.customerBalancePaisa });
      onPaid(sale);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        if (caught.code === "DISCOUNT_APPROVAL_REQUIRED" || caught.code === "CREDIT_LIMIT_EXCEEDED" || caught.code === "CUSTOMER_OVERDUE") setNeedsManager(true);
        // The same key with a different body is refused; the sale is different now, so give it a new key.
        if (caught.code === "IDEMPOTENCY_KEY_REUSED" || caught.code === "TOTAL_CHANGED") {
          useCartStore.getState().replace({ lines: cart.lines, invoiceDiscount: cart.invoiceDiscount, customerId: cart.customerId });
          if (caught.code === "TOTAL_CHANGED") void syncNow();
        }
      }
      setError(caught instanceof Error ? caught.message : "The sale could not be posted");
      sending.current = false;
      setBusy(false);
    }
  }

  return <Dialog title="Payment" onClose={() => { if (!busy) onClose(); }}>
    <form className="stack" onSubmit={pay}>
      <div className="pay-total"><span>Total due</span><strong data-testid="pay-total">{formatPkr(totalPaisa)}</strong></div>
      {rows.map((row, index) => <div className="pay-row" key={row.id}>
        <SelectInput aria-label={`Payment method ${index + 1}`} value={row.methodId} onChange={(event) => setRow(row.id, { methodId: event.target.value })}>
          {methods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}
        </SelectInput>
        <MoneyInput aria-label={`Amount ${index + 1}`} value={row.amount} autoFocus={index === 0} onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setRow(row.id, { amount: event.target.value })} />
        {kindOf(row.methodId) !== "cash" && <TextInput aria-label={`Reference ${index + 1}`} placeholder="Reference" value={row.reference} maxLength={100}
          onChange={(event) => setRow(row.id, { reference: event.target.value })} />}
        {(rows.length > 1 || customer) && <button type="button" className="icon-button" aria-label={`Remove payment ${index + 1}`} onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}>×</button>}
      </div>)}
      <div className="button-row">
        <button type="button" className="text-button" onClick={addRow}>{rows.length ? "+ Add another payment" : "+ Add a payment"}</button>
        {customer && rows.length > 0 && <button type="button" className="text-button" onClick={() => setRows([])}>Put it all on account</button>}
      </div>
      <div className="pay-summary">
        <span>Still to pay</span><strong data-testid="pay-remaining">{formatPkr(Math.max(remaining, 0))}</strong>
        <span>Change to give</span><strong data-testid="pay-change">{formatPkr(change)}</strong>
      </div>
      {customer && onAccount > 0 && <div className="notice" data-testid="pay-on-account" role="status">
        <strong>{formatPkr(onAccount)} goes on {customer.name}'s account.</strong>
        {" "}They owe {formatPkr(customer.balancePaisa)}{customer.creditLimitPaisa > 0 ? ` of a ${formatPkr(customer.creditLimitPaisa)} limit` : " and have no credit limit"}; after this sale {formatPkr(customer.balancePaisa + onAccount)}.
      </div>}
      {problem && <ErrorMessage>{problem}</ErrorMessage>}
      {needsManager && <fieldset className="stack">
        <legend>Manager approval</legend>
        <Field label="Manager email"><TextInput type="email" value={manager.email} onChange={(event) => setManager({ ...manager, email: event.target.value })} autoComplete="off" /></Field>
        <Field label="Manager PIN"><TextInput type="password" inputMode="numeric" value={manager.pin} maxLength={6} onChange={(event) => setManager({ ...manager, pin: event.target.value })} autoComplete="off" /></Field>
      </fieldset>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <button className="button primary pay-button" disabled={!canPay}>{busy ? "Posting…" : onAccount > 0 ? `Sell on account — ${formatPkr(onAccount)} owed` : `Pay ${formatPkr(totalPaisa)}`}</button>
    </form>
  </Dialog>;
}
