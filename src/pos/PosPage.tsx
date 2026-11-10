import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../shared/money";
import { formatQuantity, parseQuantity, parseSignedQuantity } from "../../shared/units";
import { getAllTerminals } from "../api/orgApi";
import { printFormatLabels, printFormats, type PrintFormat } from "../../shared/receipt";
import { holdSale, reprintSale, type PostedSale } from "../api/posApi";
import { SelectInput } from "../app/FormElements";
import { useTerminalStore } from "../app/terminalStore";
import { parseQuantity as parseQty } from "../../shared/units";
import type { PriceListItem } from "../../shared/priceLists";
import { getPriceListItems } from "../api/customersApi";
import { ReceivePaymentDialog } from "../features/customers/ReceivePaymentDialog";
import { totalsOf, type CartLine } from "./cart";
import { CustomerDialog } from "./CustomerDialog";
import { useCartStore } from "./cartStore";
import { BillDiscountDialog, HeldSalesDialog, LineDialog } from "./CartDialogs";
import type { CatalogueEntry } from "./catalogueIndex";
import { Dialog } from "./Dialog";
import { PaymentDialog } from "./PaymentDialog";
import { ReceiptPrinter, type PrintJob } from "./Receipt";
import { ReturnDialog } from "./ReturnDialog";
import { SalesHistoryDialog } from "./SalesHistoryDialog";
import { PosProvider } from "./PosProvider";
import { usePos } from "./pos-context";
import { CashMovementDialog, CloseShiftDialog, OpenShiftForm } from "./ShiftPanels";

type Modal = "customer" | "receive" | "pay" | "discount" | "held" | "cash" | "close" | "history" | "return" | { line: string } | null;

export function PosPage() {
  const terminalId = useTerminalStore((state) => state.terminalId);
  const setTerminalId = useTerminalStore((state) => state.setTerminalId);
  const terminals = useQuery({ queryKey: ["terminals-for-pos"], queryFn: getAllTerminals, enabled: !terminalId });
  if (!terminalId) {
    const active = (terminals.data ?? []).filter((terminal) => terminal.active);
    return <main className="auth-page"><section className="auth-card stack">
      <h1>Choose this till</h1>
      {terminals.isPending && <p className="muted">Loading…</p>}
      {terminals.isError && <p className="notice error">{terminals.error.message}</p>}
      {active.length > 0 && <SelectInput aria-label="Terminal" defaultValue="" onChange={(event) => { if (event.target.value) setTerminalId(event.target.value); }}>
        <option value="" disabled>Select a terminal…</option>{active.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.name}</option>)}
      </SelectInput>}
    </section></main>;
  }
  return <PosProvider><PosGate /></PosProvider>;
}

function PosGate() {
  const { shift, can } = usePos();
  if (!can("sales.create")) return <div className="full-message">Your role cannot ring up sales.</div>;
  return shift ? <PosScreen /> : <OpenShiftForm />;
}

/** "5*barcode" sells five of it; anything else is one. */
function splitQuantity(text: string): { quantityMilli: number; code: string } {
  const match = /^(\d{1,6}(?:\.\d{1,3})?)\s*[*x]\s*(.+)$/i.exec(text.trim());
  if (match) {
    try {
      const quantityMilli = parseQuantity(match[1]);
      if (quantityMilli > 0) return { quantityMilli, code: match[2].trim() };
    } catch {
      // Not a quantity: treat the whole text as the code.
    }
  }
  return { quantityMilli: 1000, code: text.trim() };
}

function PosScreen() {
  const pos = usePos();
  const { data, catalogue, can, stockOnHand } = pos;
  const cart = useCartStore();
  const searchRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [results, setResults] = useState<CatalogueEntry[] | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState("");
  const [done, setDone] = useState<PostedSale | null>(null);
  const [job, setJob] = useState<PrintJob | null>(null);
  /** The customer whose payment is being received (the "Customer payment" button), once picked. */
  const [receivingFrom, setReceivingFrom] = useState<string | null>(null);

  // A named customer buys at their tier. The list arrives once per customer and is kept until reference data changes.
  const customer = cart.customerId ? pos.customers.get(cart.customerId) : undefined;
  const tierList = useQuery({
    queryKey: ["pos-price-list", customer?.priceListId, data.versions.reference],
    queryFn: () => getPriceListItems(customer!.priceListId!),
    enabled: Boolean(customer?.priceListId),
    staleTime: Infinity,
  });
  const tier = useMemo<PriceListItem[]>(
    () => (customer?.priceListId && tierList.data ? tierList.data.items.map((item) => ({ variantId: item.variantId, unitId: item.unitId, minQuantityMilli: parseQty(item.minQuantity), pricePaisa: item.pricePaisa })) : []),
    [customer?.priceListId, tierList.data],
  );
  const waitingForTier = Boolean(customer?.priceListId) && tierList.isPending;
  const totals = useMemo(
    () => totalsOf(cart, catalogue, data.settings.taxMode, data.settings.cashRoundingPaisa, tier),
    [cart, catalogue, data.settings.taxMode, data.settings.cashRoundingPaisa, tier],
  );
  const grid = useMemo(() => catalogue.all().filter((entry) => entry.isBaseUnit).slice(0, 48), [catalogue]);
  const focusSearch = () => searchRef.current?.focus();

  function addToCart(entry: CatalogueEntry, quantityMilli = 1000) {
    cart.add(entry, quantityMilli);
    setText("");
    setResults(null);
    setNotice("");
    focusSearch();
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const { quantityMilli, code } = splitQuantity(text);
    if (!code) return;
    const scanned = catalogue.findByBarcode(code);
    if (scanned) return addToCart(scanned, quantityMilli);
    const found = catalogue.search(code);
    if (found.length === 1) return addToCart(found[0], quantityMilli);
    setResults(found);
    setNotice(found.length ? "" : `Nothing found for "${code}"`);
  }

  const jobBase = { business: data.business, dateFormat: data.settings.dateFormat, timezone: data.settings.timezone };
  /** The first print of a sale is the original. */
  const printOriginal = (sale: PostedSale, format: PrintFormat) => setJob({ ...jobBase, invoice: sale.invoice, format });
  /** Any later print is a logged duplicate, numbered by the server. */
  async function printDuplicate(saleId: string, format: PrintFormat) {
    const copy = await reprintSale(saleId, format);
    setJob({ ...jobBase, invoice: copy.invoice, format: copy.format, duplicate: { copyNumber: copy.reprintNumber } });
  }

  async function hold() {
    if (!cart.lines.length || !totals) return;
    try {
      await holdSale({ name: `Hold ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, cart: { lines: cart.lines, invoiceDiscount: cart.invoiceDiscount, customerId: cart.customerId }, totalPaisa: totals.priced.totalPaisa });
      cart.clear();
      setNotice("Sale put on hold");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not hold the sale");
    }
  }

  function startPayment() {
    if (waitingForTier) return setNotice("Loading this customer's prices…");
    if (!totals || totals.missing.length) return setNotice(totals?.missing.length ? "An item in the cart is no longer sold. Remove it first." : "Add an item first");
    setModal("pay");
  }

  // Keyboard shortcuts for the till: F2 search, F4 pay, F6 hold, F7 recall, F9 bill discount.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modal) return;
      const actions: Record<string, () => void> = {
        F2: focusSearch,
        F4: startPayment,
        F6: () => void hold(),
        F7: () => setModal("held"),
        F8: () => setModal("customer"),
        F9: () => { if (can("sales.discount")) setModal("discount"); },
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const editing = typeof modal === "object" && modal ? cart.lines.find((line) => line.key === modal.line) : undefined;
  /** Stock in base units for a cart row, and whether the row asks for more than is there while selling below zero is off. */
  const stockNote = (line: CartLine, entry: CatalogueEntry) => {
    const onHand = stockOnHand.get(line.variantId);
    if (onHand === undefined || entry.productType !== "stocked") return { text: "", short: false };
    const wanted = (line.quantityMilli * entry.factorToBaseMilli) / 1000;
    const short = !data.settings.allowNegativeStock && wanted > parseSignedQuantity(onHand);
    return { text: short ? ` · only ${onHand} in stock` : ` · ${onHand} in stock`, short };
  };

  return <div className="pos">
    <header className="pos-bar">
      <strong>{data.business.tradeName}</strong>
      <span>{data.branch.name} · {data.terminal.name}</span>
      <span>{data.user.name ?? data.user.email}</span>
      <span className="grow" />
      {pos.catalogueStatus !== "ready" && <span className="status" role="status">{pos.catalogueStatus === "error" ? "Products not loaded" : "Updating products…"}</span>}
      <button className="button secondary" onClick={() => setModal("history")}>Recent sales</button>
      <button className="button secondary" onClick={() => setModal("held")}>Held (F7)</button>
      {can("sales.return") && <button className="button secondary" onClick={() => setModal("return")}>Return</button>}
      {can("customers.receive_payment") && <button className="button secondary" onClick={() => setModal("receive")}>Customer payment</button>}
      {can("cash.movement") && <button className="button secondary" onClick={() => setModal("cash")}>Cash in/out</button>}
      {can("shifts.close") && <button className="button secondary" onClick={() => setModal("close")}>Close shift</button>}
      {can("catalog.view") && <Link className="button secondary" to="/">Back office</Link>}
    </header>

    <div className="pos-main">
      <section className="pos-left">
        <form onSubmit={submitSearch} role="search">
          <input ref={searchRef} className="input pos-search" aria-label="Scan or search" placeholder="Scan a barcode or type a name or SKU (F2) — 5*code sells five" value={text}
            onChange={(event) => { setText(event.target.value); if (!event.target.value) setResults(null); }} autoFocus autoComplete="off" />
        </form>
        {pos.catalogueError && <p className="notice error">{pos.catalogueError}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="pos-grid" aria-label={results ? "Search results" : "Items"}>
          {(results ?? grid).map((entry) => <button key={`${entry.variantId}|${entry.unitId}`} className="tile" onClick={() => addToCart(entry)}>
            <span className="tile-name">{entry.productName}{entry.variantName ? ` — ${entry.variantName}` : ""}</span>
            <span className="tile-meta">{entry.sku} · {entry.unitName}{entry.isBaseUnit && entry.productType === "stocked" && stockOnHand.has(entry.variantId) ? ` · ${stockOnHand.get(entry.variantId)} in stock` : ""}</span>
            <strong>{formatPkr(entry.pricePaisa)}</strong>
          </button>)}
          {catalogue.size === 0 && pos.catalogueStatus === "ready" && <p className="muted">No products yet. Add products in the back office.</p>}
        </div>
      </section>

      <aside className="pos-right">
        <div className="customer-bar">
          <div><small>Customer (F8)</small><strong data-testid="cart-customer">{customer ? customer.name : cart.customerId ? "Unknown customer" : "Walk-in"}</strong>{customer?.priceListId && <small>Tier: {data.priceLists.find((list) => list.id === customer.priceListId)?.name ?? "price list"}</small>}
            {customer && (customer.balancePaisa !== 0 || customer.creditLimitPaisa > 0) && <small data-testid="cart-customer-account" className={customer.balancePaisa > customer.creditLimitPaisa ? "short" : undefined}>
              {customer.balancePaisa < 0 ? `Credit ${formatPkr(-customer.balancePaisa)}` : `Owes ${formatPkr(customer.balancePaisa)}`}{customer.creditLimitPaisa > 0 ? ` · limit ${formatPkr(customer.creditLimitPaisa)}` : ""}
            </small>}</div>
          <button className="button secondary" onClick={() => setModal("customer")}>{cart.customerId ? "Change" : "Select"}</button>
        </div>
        <div className="cart-scroll">
          <table className="cart-table" aria-label="Cart">
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Total</th></tr></thead>
            <tbody>
              {totals?.lines.map(({ line, entry, unitPricePaisa }, index) => <tr key={line.key} onClick={() => setModal({ line: line.key })} className="cart-row">
                <td><span>{entry.productName}{entry.variantName ? ` — ${entry.variantName}` : ""}</span><small>{entry.sku} · {entry.unitName}{line.discount ? " · discount" : ""}<span className={stockNote(line, entry).short ? "short" : undefined}>{stockNote(line, entry).text}</span></small></td>
                <td className="num">{formatQuantity(line.quantityMilli)}</td>
                <td className="num">{formatPkr(unitPricePaisa)}</td>
                <td className="num">{formatPkr(totals.priced.lines[index].totalPaisa)}</td>
              </tr>)}
              {totals?.missing.map((line) => <tr key={line.key} className="cart-row missing" onClick={() => setModal({ line: line.key })}><td colSpan={4}>Item no longer sold — click to remove</td></tr>)}
              {!cart.lines.length && <tr><td colSpan={4} className="muted">The cart is empty. Scan an item to begin.</td></tr>}
            </tbody>
          </table>
        </div>
        <dl className="totals">
          {totals && <>
            <div><dt>Subtotal</dt><dd>{formatPkr(totals.priced.grossPaisa)}</dd></div>
            {totals.priced.discountPaisa > 0 && <div><dt>Discount</dt><dd>-{formatPkr(totals.priced.discountPaisa)}</dd></div>}
            <div><dt>Tax {data.settings.taxMode === "inclusive" ? "(included)" : ""}</dt><dd>{formatPkr(totals.priced.taxPaisa)}</dd></div>
            {totals.priced.roundingPaisa !== 0 && <div><dt>Rounding</dt><dd>{formatPkr(totals.priced.roundingPaisa)}</dd></div>}
          </>}
          <div className="grand"><dt>Total</dt><dd data-testid="cart-total">{formatPkr(totals?.priced.totalPaisa ?? 0)}</dd></div>
        </dl>
        <div className="button-row">
          {can("sales.discount") && <button className="button secondary" disabled={!cart.lines.length} onClick={() => setModal("discount")}>Bill discount (F9)</button>}
          <button className="button secondary" disabled={!cart.lines.length} onClick={() => void hold()}>Hold (F6)</button>
          <button className="button secondary" disabled={!cart.lines.length} onClick={() => cart.clear()}>Clear</button>
        </div>
        <button className="button primary pay-button" disabled={!totals} onClick={startPayment}>Pay (F4)</button>
      </aside>
    </div>

    {modal === "pay" && totals && <PaymentDialog cart={cart} totalPaisa={totals.priced.totalPaisa} onClose={() => { setModal(null); focusSearch(); }}
      onPaid={(sale) => { cart.clear(); setModal(null); setDone(sale); }} />}
    {modal === "customer" && <CustomerDialog onClose={() => { setModal(null); focusSearch(); }} onPick={(customerId) => { cart.setCustomer(customerId); setModal(null); focusSearch(); }} />}
    {modal === "receive" && !receivingFrom && <CustomerDialog onClose={() => { setModal(null); focusSearch(); }} onPick={(customerId) => { if (customerId) setReceivingFrom(customerId); else setModal(null); }} />}
    {modal === "receive" && receivingFrom && <ReceivePaymentDialog customerId={receivingFrom} methods={data.paymentMethods}
      print={{ ...jobBase, defaultFormat: data.terminal.defaultPrintFormat }}
      onPosted={(payment) => { const held = pos.customers.get(payment.customerId); if (held) pos.rememberCustomer({ ...held, balancePaisa: payment.customerBalancePaisa }); }}
      onClose={() => { setReceivingFrom(null); setModal(null); focusSearch(); }} />}
    {modal === "discount" && <BillDiscountDialog current={cart.invoiceDiscount} onClose={() => setModal(null)} onApply={(discount) => { cart.setInvoiceDiscount(discount); setModal(null); focusSearch(); }} />}
    {modal === "held" && <HeldSalesDialog onClose={() => setModal(null)} onRecalled={(recalled) => {
      // Whatever was in the cart goes on hold first, so recalling never loses a sale in progress.
      if (cart.lines.length && totals) {
        void holdSale({ name: "Hold (before recall)", cart: { lines: cart.lines, invoiceDiscount: cart.invoiceDiscount, customerId: cart.customerId }, totalPaisa: totals.priced.totalPaisa }).catch(() => setNotice("The previous cart could not be put on hold"));
      }
      cart.replace(recalled);
      setModal(null);
      focusSearch();
    }} />}
    {modal === "cash" && <CashMovementDialog onClose={() => setModal(null)} onDone={(message) => { setNotice(message); setModal(null); focusSearch(); }} />}
    {modal === "close" && <CloseShiftDialog onClose={() => setModal(null)} onClosed={() => { cart.clear(); setModal(null); }} />}
    {editing && <LineDialog line={editing} tier={tier} onClose={() => setModal(null)}
      onApply={(change) => { cart.update(editing.key, change); setModal(null); focusSearch(); }}
      onRemove={() => { cart.remove(editing.key); setModal(null); focusSearch(); }} />}
    {modal === "return" && <ReturnDialog onClose={() => { setModal(null); focusSearch(); }} />}
    {modal === "history" && <SalesHistoryDialog onClose={() => setModal(null)} onReprint={printDuplicate} />}
    {done && <SaleDone sale={done} onNext={() => { setDone(null); focusSearch(); }} onPrintOriginal={printOriginal} onPrintDuplicate={printDuplicate} />}
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}

function SaleDone({ sale, onNext, onPrintOriginal, onPrintDuplicate }: {
  sale: PostedSale; onNext: () => void; onPrintOriginal: (sale: PostedSale, format: PrintFormat) => void; onPrintDuplicate: (saleId: string, format: PrintFormat) => Promise<void>;
}) {
  const { data, can } = usePos();
  const { invoice } = sale;
  const [format, setFormat] = useState<PrintFormat>(data.terminal.defaultPrintFormat);
  const [printed, setPrinted] = useState(false);
  const [error, setError] = useState("");
  const autoPrinted = useRef(false);

  // The receipt prints by itself when the shop wants it to; that print is the original.
  useEffect(() => {
    if (autoPrinted.current || !data.settings.autoPrintReceipt) return;
    autoPrinted.current = true;
    onPrintOriginal(sale, format);
    setPrinted(true);
  }, [data.settings.autoPrintReceipt, sale, format, onPrintOriginal]);

  async function print() {
    setError("");
    try {
      if (!printed) {
        onPrintOriginal(sale, format);
        setPrinted(true);
      } else {
        await onPrintDuplicate(invoice.id, format);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not print");
    }
  }

  return <Dialog title="Sale complete" onClose={onNext}><div className="stack">
    <p className="eyebrow">{invoice.number}</p>
    <dl className="totals">
      <div className="grand"><dt>Total</dt><dd data-testid="done-total">{formatPkr(invoice.totalPaisa)}</dd></div>
      {invoice.payments.map((payment) => <div key={payment.methodCode + payment.reference}><dt>{payment.methodName}{payment.reference ? ` (${payment.reference})` : ""}</dt><dd>{formatPkr(payment.tenderedPaisa)}</dd></div>)}
      <div><dt>Change</dt><dd data-testid="done-change">{formatPkr(invoice.changePaisa)}</dd></div>
      {invoice.balancePaisa > 0 && <div><dt>On {invoice.customerName}'s account</dt><dd data-testid="done-on-account">{formatPkr(invoice.balancePaisa)}</dd></div>}
    </dl>
    <div className="pay-row">
      <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
        {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
      </SelectInput>
      <button className="button secondary" disabled={printed && !can("sales.reprint")} onClick={() => void print()}>{printed ? "Print duplicate" : "Print"}</button>
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
    <button className="button primary" onClick={onNext} autoFocus>New sale</button>
  </div></Dialog>;
}
