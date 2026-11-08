import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatPkr } from "../../shared/money";
import { priceCart } from "../../shared/pricing";
import { printFormatLabels, printFormats, type PrintFormat } from "../../shared/receipt";
import { priceReturn, remainingToReturn, returnedBaseQuantity, ReturnError, type SoldLine } from "../../shared/returns";
import { restockChoices, restockLabels, type RestockChoice } from "../../shared/schemas/returns";
import { parseQuantity } from "../../shared/units";
import { getAllSales } from "../api/posApi";
import { getReturnableLinesForInvoice, postSalesReturn, reprintReturn, type CreditNote, type PostedReturn } from "../api/returnsApi";
import { ErrorMessage, Field, SelectInput, TextInput } from "../app/FormElements";
import type { CatalogueEntry } from "./catalogueIndex";
import { Dialog } from "./Dialog";
import { QuantityInput } from "../app/QuantityInput";
import { usePos } from "./pos-context";
import { ReceiptPrinter, type PrintJob } from "./Receipt";

/** A typed quantity in thousandths, or null while it is empty or not a quantity. */
function milliOf(text: string): number | null {
  if (!text.trim()) return null;
  try {
    const value = parseQuantity(text);
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

type Chosen = { kind: "invoice"; id: string } | { kind: "none" } | null;

/**
 * Takes goods back. Find the bill, say how many of each item come back and where they go, and say how to settle the money.
 * A return after the window, or with no bill at all, needs a manager's PIN. Pressing the button sends one request; the key
 * keeps a repeat press, or a retry after a lost reply, from posting a second credit note.
 */
export function ReturnDialog({ onClose }: { onClose: () => void }) {
  const [chosen, setChosen] = useState<Chosen>(null);
  const [done, setDone] = useState<PostedReturn | null>(null);
  if (done) return <ReturnDone note={done.creditNote} onClose={onClose} />;
  if (!chosen) return <FindInvoice onClose={onClose} onChoose={setChosen} />;
  return <ReturnItems chosen={chosen} onBack={() => setChosen(null)} onClose={onClose} onPosted={setDone} />;
}

function FindInvoice({ onClose, onChoose }: { onClose: () => void; onChoose: (chosen: Chosen) => void }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const list = useQuery({ queryKey: ["return-find", search], queryFn: ({ signal }) => getAllSales({ q: search, pageSize: 8 }, signal), placeholderData: keepPreviousData, staleTime: 0 });

  return <Dialog title="Take goods back" onClose={onClose} wide><div className="stack">
    <TextInput aria-label="Find the bill" placeholder="Bill number, for example 000042" value={text} onChange={(event) => setText(event.target.value)} autoFocus />
    {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
    <table className="report-table" aria-label="Bills">
      <tbody>
        {list.data?.data.map((sale) => <tr key={sale.id}>
          <td>{sale.number}<small className="block muted">{new Date(sale.postedAt).toLocaleString()} · {sale.cashierName}</small></td>
          <td className="num">{formatPkr(sale.totalPaisa)}</td>
          <td className="num"><button className="button secondary" onClick={() => onChoose({ kind: "invoice", id: sale.id })}>Return from this bill</button></td>
        </tr>)}
        {list.data?.data.length === 0 && <tr><td colSpan={3} className="muted">No bills found.</td></tr>}
      </tbody>
    </table>
    <button className="button secondary" onClick={() => onChoose({ kind: "none" })}>The customer has no bill</button>
  </div></Dialog>;
}

type Picked = { entry: CatalogueEntry; quantity: string; restockTo: RestockChoice };

function ReturnItems({ chosen, onBack, onClose, onPosted }: { chosen: NonNullable<Chosen>; onBack: () => void; onClose: () => void; onPosted: (posted: PostedReturn) => void }) {
  const { data, shift, applyStock, customers, rememberCustomer, catalogue } = usePos();
  const queryClient = useQueryClient();
  const invoiceId = chosen.kind === "invoice" ? chosen.id : "";
  const returnable = useQuery({ queryKey: ["returnable", invoiceId], queryFn: () => getReturnableLinesForInvoice(invoiceId), enabled: chosen.kind === "invoice", staleTime: 0 });
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [restocks, setRestocks] = useState<Record<string, RestockChoice>>({});
  const [picked, setPicked] = useState<Picked[]>([]);
  const [find, setFind] = useState("");
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState(""); // a payment method id, or "account"
  const [reference, setReference] = useState("");
  const [manager, setManager] = useState({ email: "", pin: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(`return-${crypto.randomUUID()}`);
  const sending = useRef(false);

  const cash = data.paymentMethods.find((method) => method.kind === "cash") ?? data.paymentMethods[0];
  const methodId = destination === "account" ? "" : destination || cash.id;
  const method = data.paymentMethods.find((row) => row.id === methodId);
  const info = returnable.data;
  const customerId = info?.invoice.customerId ?? null;
  const approvalNeeded = chosen.kind === "none" || Boolean(info?.outsideWindow);

  // The sums are the server's own (shared/returns.ts and shared/pricing.ts), so what is shown is what will be posted.
  const lineRows = useMemo(() => (info?.lines ?? []).map((line) => {
    const sold: SoldLine = {
      id: line.lineId, qtyBase: parseQuantity(line.qtyBase), returnedBase: parseQuantity(line.returnedBase), grossPaisa: line.grossPaisa, lineDiscountPaisa: line.lineDiscountPaisa,
      invoiceDiscountSharePaisa: line.invoiceDiscountSharePaisa, taxPaisa: line.taxPaisa, totalPaisa: line.totalPaisa, taxIncluded: line.taxIncluded,
    };
    return { line, sold, factor: parseQuantity(line.factorToBase), entered: milliOf(quantities[line.lineId] ?? "") };
  }), [info, quantities]);

  const preview = useMemo(() => {
    try {
      if (chosen.kind === "invoice") {
        if (!info) return null;
        const returning = lineRows.filter((row) => row.entered !== null).map((row) => ({ lineId: row.line.lineId, qtyBase: returnedBaseQuantity(row.sold, row.factor, row.entered!) }));
        return returning.length ? priceReturn({ lines: lineRows.map((row) => row.sold), roundingPaisa: info.invoice.roundingPaisa, returning }).totalPaisa : 0;
      }
      const lines = picked.filter((row) => milliOf(row.quantity) !== null);
      return lines.length ? priceCart({ taxMode: data.settings.taxMode, lines: lines.map((row) => ({ qtyMilli: milliOf(row.quantity)!, unitPricePaisa: row.entry.pricePaisa, taxRateBps: row.entry.taxRateBps })) }).totalPaisa : 0;
    } catch (caught) {
      if (caught instanceof ReturnError) return caught.message;
      return null;
    }
  }, [chosen.kind, info, lineRows, picked, data.settings.taxMode]);

  const total = typeof preview === "number" ? preview : 0;
  const owed = info?.owedPaisa ?? 0;
  const payOff = customerId ? Math.min(total, owed) : 0;
  const handedBack = destination === "account" ? 0 : total - payOff;
  const toAccount = total - handedBack;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!shift || sending.current || typeof preview !== "number" || preview <= 0) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const lines = chosen.kind === "invoice"
        ? lineRows.filter((row) => row.entered !== null).map((row) => ({ originalLineId: row.line.lineId, quantity: quantities[row.line.lineId].trim(), restockTo: restocks[row.line.lineId] ?? "sellable" as const, reason: "" }))
        : picked.filter((row) => milliOf(row.quantity) !== null).map((row) => ({ variantId: row.entry.variantId, unitId: row.entry.unitId, quantity: row.quantity.trim(), restockTo: row.restockTo, reason: "" }));
      const posted = await postSalesReturn({
        shiftId: shift.id, ...(chosen.kind === "invoice" ? { invoiceId: chosen.id } : {}), lines, reason,
        refund: { ...(destination === "account" ? {} : { methodId }), reference },
        ...(approvalNeeded && manager.email ? { approval: { managerEmail: manager.email.trim(), pin: manager.pin } } : {}),
      }, key.current);
      applyStock(posted.stock);
      const held = posted.creditNote.customerId ? customers.get(posted.creditNote.customerId) : undefined;
      if (held && posted.creditNote.customerBalancePaisa !== null) rememberCustomer({ ...held, balancePaisa: posted.creditNote.customerBalancePaisa });
      await queryClient.invalidateQueries({ queryKey: ["returns"] });
      onPosted(posted);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The return could not be recorded");
      setBusy(false);
      sending.current = false;
    }
  }

  const found = chosen.kind === "none" && find.trim() ? catalogue.search(find.trim(), 8) : [];
  const nothingEntered = typeof preview !== "number" || preview <= 0;

  return <Dialog title={chosen.kind === "invoice" ? `Return from ${info?.invoice.number ?? "bill"}` : "Return without a bill"} onClose={() => { if (!busy) onClose(); }} wide>
    <form className="stack" onSubmit={submit}>
      {chosen.kind === "invoice" && returnable.isPending && <p className="muted">Loading the bill…</p>}
      {returnable.isError && <ErrorMessage>{returnable.error.message}</ErrorMessage>}
      {info && <>
        {info.invoice.customerName && <p>Customer: <strong>{info.invoice.customerName}</strong>{owed > 0 ? ` — still owes ${formatPkr(owed)} on this bill` : ""}</p>}
        {info.outsideWindow && <p className="notice error" role="status">This bill is older than {info.windowDays} days. A manager must approve the return.</p>}
        <div className="table-scroll"><table className="report-table return-table" aria-label="Items on the bill">
          <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Left to return</th><th>Bring back</th><th>Goes to</th></tr></thead>
          <tbody>
            {lineRows.map(({ line, sold, factor, entered }) => {
              const left = remainingToReturn(sold, factor);
              const tooMany = entered !== null && entered > left;
              return <tr key={line.lineId}>
                <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku} · {line.unitName} · {formatPkr(line.unitPricePaisa)}</small></td>
                <td className="num">{line.quantity}</td><td className="num">{line.remainingQuantity}</td>
                <td><QuantityInput aria-label={`Quantity of ${line.productName} to return`} value={quantities[line.lineId] ?? ""} disabled={left <= 0}
                  onChange={(event) => setQuantities({ ...quantities, [line.lineId]: event.target.value })} />{tooMany && <small className="short">only {line.remainingQuantity} left</small>}</td>
                <td><SelectInput aria-label={`Where ${line.productName} goes`} value={restocks[line.lineId] ?? "sellable"} onChange={(event) => setRestocks({ ...restocks, [line.lineId]: event.target.value as RestockChoice })}>
                  {restockChoices.map((choice) => <option key={choice} value={choice}>{restockLabels[choice]}</option>)}
                </SelectInput></td>
              </tr>;
            })}
          </tbody>
        </table></div>
      </>}

      {chosen.kind === "none" && <>
        <p className="notice" role="status">Without a bill the goods come back at today's price, and a manager must approve.</p>
        <TextInput aria-label="Find the item" placeholder="Name, SKU or barcode" value={find} onChange={(event) => setFind(event.target.value)} autoFocus />
        {found.map((entry) => <button key={`${entry.variantId}|${entry.unitId}`} type="button" className="button secondary" onClick={() => { setPicked([...picked, { entry, quantity: "1", restockTo: "sellable" }]); setFind(""); }}>
          {entry.productName}{entry.variantName ? ` — ${entry.variantName}` : ""} · {entry.unitName} · {formatPkr(entry.pricePaisa)}
        </button>)}
        {picked.length > 0 && <table className="report-table" aria-label="Items coming back">
          <tbody>{picked.map((row, index) => <tr key={index}>
            <td>{row.entry.productName}<small className="block muted">{row.entry.sku} · {row.entry.unitName} · {formatPkr(row.entry.pricePaisa)}</small></td>
            <td><QuantityInput aria-label={`Quantity of ${row.entry.productName} to return`} value={row.quantity} onChange={(event) => setPicked(picked.map((item, at) => (at === index ? { ...item, quantity: event.target.value } : item)))} /></td>
            <td><SelectInput aria-label={`Where ${row.entry.productName} goes`} value={row.restockTo} onChange={(event) => setPicked(picked.map((item, at) => (at === index ? { ...item, restockTo: event.target.value as RestockChoice } : item)))}>
              {restockChoices.map((choice) => <option key={choice} value={choice}>{restockLabels[choice]}</option>)}
            </SelectInput></td>
            <td><button type="button" className="text-button" onClick={() => setPicked(picked.filter((_, at) => at !== index))}>Remove</button></td>
          </tr>)}</tbody>
        </table>}
      </>}

      <div className="pay-total"><span>Value of the goods</span><strong data-testid="return-total">{formatPkr(total)}</strong></div>
      {typeof preview === "string" && <ErrorMessage>{preview}</ErrorMessage>}

      <Field label="How is the customer settled?">
        <SelectInput value={destination || cash.id} onChange={(event) => setDestination(event.target.value)}>
          {data.paymentMethods.map((row) => <option key={row.id} value={row.id}>Refund — {row.name}</option>)}
          {customerId && <option value="account">Keep it on {info?.invoice.customerName ?? "the customer"}'s account (store credit)</option>}
        </SelectInput>
      </Field>
      {customerId && payOff > 0 && <p className="muted" data-testid="return-pay-off">{formatPkr(payOff)} of this pays off what {info?.invoice.customerName} owes on the bill{handedBack > 0 ? `; ${formatPkr(handedBack)} is refunded.` : "."}</p>}
      {toAccount > 0 && payOff === 0 && <p className="muted">{formatPkr(toAccount)} goes onto the customer's account as credit.</p>}
      {destination !== "account" && method && method.kind !== "cash" && handedBack > 0 && <Field label="Reference"><TextInput value={reference} maxLength={100} onChange={(event) => setReference(event.target.value)} /></Field>}
      <Field label="Reason (optional)"><TextInput value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></Field>

      {approvalNeeded && <fieldset className="stack">
        <legend>Manager approval</legend>
        <Field label="Manager email"><TextInput type="email" value={manager.email} onChange={(event) => setManager({ ...manager, email: event.target.value })} autoComplete="off" /></Field>
        <Field label="Manager PIN"><TextInput type="password" inputMode="numeric" value={manager.pin} maxLength={8} onChange={(event) => setManager({ ...manager, pin: event.target.value })} autoComplete="off" /></Field>
      </fieldset>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="button-row">
        <button type="button" className="button secondary" disabled={busy} onClick={onBack}>Back</button>
        <button className="button primary" disabled={busy || nothingEntered || !shift}>{busy ? "Posting…" : `Take back ${formatPkr(total)}`}</button>
      </div>
    </form>
  </Dialog>;
}

function ReturnDone({ note, onClose }: { note: CreditNote; onClose: () => void }) {
  const { data, can } = usePos();
  const [format, setFormat] = useState<PrintFormat>(data.terminal.defaultPrintFormat);
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState("");
  const base = { business: data.business, dateFormat: data.settings.dateFormat, timezone: data.settings.timezone };
  const printed = useRef(false);
  useEffect(() => {
    // The first print is the original, as with a sale.
    if (printed.current || !data.settings.autoPrintReceipt) return;
    printed.current = true;
    setJob({ ...base, format, creditNote: note });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Any later print is a logged duplicate, numbered by the server. */
  async function printAgain() {
    setError("");
    try {
      const copy = await reprintReturn(note.id, format);
      setJob({ ...base, format: copy.format, creditNote: copy.creditNote, duplicate: { copyNumber: copy.reprintNumber } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reprint the credit note");
    }
  }

  return <Dialog title="Goods taken back" onClose={onClose}><div className="stack">
    <p className="eyebrow">{note.number}</p>
    <dl className="totals">
      <div className="grand"><dt>Credit note</dt><dd data-testid="return-done-total">{formatPkr(note.totalPaisa)}</dd></div>
      {note.refundPaisa > 0 && <div><dt>Refunded — {note.refundMethodName}</dt><dd data-testid="return-done-refund">{formatPkr(note.refundPaisa)}</dd></div>}
      {note.accountCreditPaisa > 0 && <div><dt>Taken off the account</dt><dd data-testid="return-done-account">{formatPkr(note.accountCreditPaisa)}</dd></div>}
      {note.customerName && note.customerBalancePaisa !== null && <div><dt>{note.customerBalancePaisa < 0 ? "Credit on account" : "Still owed"}</dt><dd data-testid="return-done-balance">{formatPkr(Math.abs(note.customerBalancePaisa))}</dd></div>}
    </dl>
    <div className="pay-row">
      <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
        {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
      </SelectInput>
      {can("sales.reprint") && <button className="button secondary" onClick={() => void printAgain()}>Print duplicate</button>}
    </div>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <button className="button primary" onClick={onClose} autoFocus>Done</button>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div></Dialog>;
}
