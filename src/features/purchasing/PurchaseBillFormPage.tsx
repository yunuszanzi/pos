import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { formatBps, formatPkr, parsePercentToBps } from "../../../shared/money";
import { allocateByValue, billTotals, inputTaxOf, landedCostPerBase } from "../../../shared/purchaseBills";
import { purchaseLineValue } from "../../../shared/purchasing";
import { purchaseBillSchema } from "../../../shared/schemas/bills";
import { parseQuantity, toBaseQuantity } from "../../../shared/units";
import { getBillableReceiptLines, postPurchaseBill } from "../../api/billsApi";
import { ErrorMessage, Field, PageTitle, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { QuantityInput } from "../../app/QuantityInput";
import { amountOf } from "../../pos/amounts";
import { SupplierPicker, type PickedSupplier } from "../suppliers/SupplierPicker";
import { momentDayText } from "./dayText";

/** A tax rate typed as a percentage, in basis points; 0 while it is not a valid rate (the form says so on submit). */
function rateOf(text: string): number {
  try {
    return parsePercentToBps(text || "0");
  } catch {
    return 0;
  }
}

type Row = { quantity: string; cost: string; taxPercent: string };
type Charge = { key: string; description: string; amount: string };

/**
 * Enters the supplier's bill for goods already received: the price on their invoice for each item, any freight, and input tax.
 * Freight is shared across the items by value and becomes part of what the goods cost; tax does not.
 */
export function PurchaseBillFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [supplier, setSupplier] = useState<PickedSupplier | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [billDate, setBillDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [note, setNote] = useState("");
  // What is typed for each received line, by its id. A line with no entry is not on the bill.
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [charges, setCharges] = useState<Charge[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for this form: a double click or a retry after a dropped connection enters the bill once.
  const key = useRef(`bill-${crypto.randomUUID()}`);

  const billable = useQuery({ queryKey: ["billable-lines", supplier?.id], queryFn: ({ signal }) => getBillableReceiptLines(supplier!.id, 1, signal), enabled: Boolean(supplier), staleTime: 0 });
  const lines = billable.data?.data ?? [];

  const toggle = (id: string, on: boolean, unbilled: string, cost: number) => {
    const next = { ...rows };
    if (on) next[id] = { quantity: unbilled, cost: (cost / 100).toFixed(2), taxPercent: "0" };
    else delete next[id];
    setRows(next);
  };
  const change = (id: string, patch: Partial<Row>) => setRows({ ...rows, [id]: { ...rows[id], ...patch } });

  // The same sums the server does (shared/purchaseBills.ts), so what is shown is what will be recorded.
  const picked = lines.filter((line) => rows[line.id]).map((line) => {
    const row = rows[line.id];
    let entered = 0;
    let cost: number | null = amountOf(row.cost);
    try {
      entered = parseQuantity(row.quantity || "0");
    } catch {
      cost = null;
    }
    const valuePaisa = cost === null ? 0 : purchaseLineValue(entered, cost);
    const bps = rateOf(row.taxPercent);
    return { line, row, entered, cost, valuePaisa, bps, taxPaisa: inputTaxOf(valuePaisa, bps), qtyBase: entered > 0 ? toBaseQuantity(entered, parseQuantity(line.factorToBase)) : 0 };
  });
  const chargeAmounts = charges.map((charge) => amountOf(charge.amount) ?? 0);
  const chargeTotal = chargeAmounts.reduce((sum, amount) => sum + amount, 0);
  const shares = allocateByValue(chargeTotal, picked.map((item) => item.valuePaisa));
  const totals = billTotals(picked, chargeAmounts);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!supplier) return setError("Choose the supplier");
    if (picked.some((item) => item.cost === null)) return setError("A price is not a valid amount. Use rupees with up to two decimals, for example 3200.00");
    if (charges.some((charge) => charge.amount.trim() && amountOf(charge.amount) === null)) return setError("A charge is not a valid amount. Use rupees with up to two decimals");
    let rates: number[];
    try {
      rates = picked.map((item) => parsePercentToBps(item.row.taxPercent || "0"));
    } catch {
      return setError("A tax rate is not valid. Use a percentage such as 18 or 7.5");
    }
    const input = {
      supplierId: supplier.id, supplierInvoiceNo: invoiceNo, billDate, note,
      lines: picked.map((item, index) => ({ receiptLineId: item.line.id, quantity: item.row.quantity.trim(), unitCostPaisa: item.cost!, taxRateBps: rates[index] })),
      charges: charges.filter((charge) => charge.description.trim() || charge.amount.trim()).map((charge) => ({ description: charge.description, amountPaisa: amountOf(charge.amount) ?? 0 })),
    };
    const checked = purchaseBillSchema.safeParse(input);
    if (!checked.success) return setError(checked.error.issues[0].message);
    setBusy(true);
    try {
      const posted = await postPurchaseBill(input, key.current);
      await Promise.all(["purchase-bills", "suppliers", "supplier-ledger", "supplier-ageing", "billable-lines", "stock"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/purchase-bills/${posted.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not enter the bill");
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="Enter a supplier bill" description="Choose the supplier, tick the received goods the bill is for, and copy the prices, freight and tax from their invoice." />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <SupplierPicker value={supplier} onChange={(next) => { setSupplier(next); setRows({}); }} />
          <Field label="Supplier's invoice number"><TextInput value={invoiceNo} maxLength={60} onChange={(event) => setInvoiceNo(event.target.value)} /></Field>
          <Field label="Bill date"><TextInput type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} /></Field>
          <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
        </div>
      </section>

      {supplier && <section className="panel stack">
        <h2>Received and not yet billed</h2>
        {billable.isPending && <p className="muted">Loading…</p>}
        {billable.isError && <ErrorMessage>{billable.error.message}</ErrorMessage>}
        {billable.isSuccess && lines.length === 0 && <p className="muted">Nothing received from {supplier.name} is waiting for a bill. Receive the goods first.</p>}
        {lines.map((line) => {
          const row = rows[line.id];
          const item = picked.find((entry) => entry.line.id === line.id);
          const index = picked.findIndex((entry) => entry.line.id === line.id);
          return <div className="form-grid" key={line.id} role="group" aria-label={`Received ${line.receiptNumber} ${line.sku}`}>
            <label className="checkbox-row">
              <input type="checkbox" checked={Boolean(row)} onChange={(event) => toggle(line.id, event.target.checked, line.unbilledQuantity, line.unitCostPaisa)} />
              <span><strong>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}</strong><br /><span className="mono">{line.sku}</span>
                <small className="block muted">{line.receiptNumber}, {momentDayText(line.receivedAt)} · {line.unbilledQuantity} {line.unitName} to bill{line.supplierRef ? ` · ${line.supplierRef}` : ""}</small></span>
            </label>
            {row && <>
              <Field label={`Billed (${line.unitName})`}><QuantityInput value={row.quantity} onChange={(event) => change(line.id, { quantity: event.target.value })} /></Field>
              <Field label="Price on their invoice (Rs)"><MoneyInput value={row.cost} onChange={(event) => change(line.id, { cost: event.target.value })} /></Field>
              <Field label="Tax (%)"><QuantityInput decimals={2} value={row.taxPercent} onChange={(event) => change(line.id, { taxPercent: event.target.value })} /></Field>
              <div><span className="muted">Value</span><br /><strong>{formatPkr(item?.valuePaisa ?? 0)}</strong>
                {item && item.qtyBase > 0 && <small className="block muted">costs {formatPkr(landedCostPerBase({ valuePaisa: item.valuePaisa, chargeSharePaisa: shares[index] ?? 0, qtyBaseMilli: item.qtyBase }))} a piece with freight</small>}</div>
            </>}
          </div>;
        })}
      </section>}

      {picked.length > 0 && <section className="panel stack">
        <h2>Freight and other charges</h2>
        <p className="muted">Shared across the items by value and counted in what the goods cost. Tax is not.</p>
        {charges.map((charge, index) => <div className="form-grid" key={charge.key} role="group" aria-label={`Charge ${index + 1}`}>
          <Field label="What for"><TextInput value={charge.description} maxLength={100} onChange={(event) => setCharges(charges.map((entry) => (entry.key === charge.key ? { ...entry, description: event.target.value } : entry)))} /></Field>
          <Field label="Amount (Rs)"><MoneyInput value={charge.amount} onChange={(event) => setCharges(charges.map((entry) => (entry.key === charge.key ? { ...entry, amount: event.target.value } : entry)))} /></Field>
          <button type="button" className="text-button" onClick={() => setCharges(charges.filter((entry) => entry.key !== charge.key))}>Remove</button>
        </div>)}
        <div className="button-row"><button type="button" className="button secondary" onClick={() => setCharges([...charges, { key: crypto.randomUUID(), description: charges.length === 0 ? "Freight" : "", amount: "" }])}>Add a charge</button></div>
        <dl className="totals">
          <div><dt>Items</dt><dd>{formatPkr(totals.subtotalPaisa)}</dd></div>
          <div><dt>Freight and charges</dt><dd>{formatPkr(totals.chargesPaisa)}</dd></div>
          <div><dt>Input tax{picked.length === 1 && picked[0].bps ? ` (${formatBps(picked[0].bps)}%)` : ""}</dt><dd>{formatPkr(totals.taxPaisa)}</dd></div>
          <div className="grand"><dt>Bill total</dt><dd data-testid="bill-total">{formatPkr(totals.totalPaisa)}</dd></div>
        </dl>
      </section>}

      <div className="button-row">
        <button className="button primary" disabled={busy || !supplier || picked.length === 0}>{busy ? "Entering…" : "Enter bill"}</button>
        <Link className="button secondary" to="/purchase-bills">Cancel</Link>
      </div>
    </form>
  </div>;
}
