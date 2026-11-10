import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { paymentTermChoices, salesInvoiceSchema } from "../../../shared/schemas/salesInvoices";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import type { Quotation } from "../../api/quotationsApi";
import type { SalesOrder } from "../../api/salesOrdersApi";
import { postSalesInvoice } from "../../api/salesInvoicesApi";
import { ErrorMessage, Field, SelectInput, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";
import { CustomerPicker, type PickedCustomer } from "../customers/CustomerPicker";

type Source = { kind: "order"; order: SalesOrder } | { kind: "quotation"; quotation: Quotation };

/** One billable line, whichever document it came from: how much can still be billed, in the unit it was written in (thousandths). */
type Billable = { id: string; productName: string; variantName: string; sku: string; unitName: string; unitPricePaisa: number; leftMilli: number };

function billableOf(source: Source): Billable[] {
  if (source.kind === "order") {
    // Only goods that have gone out can be billed: delivered less billed.
    return source.order.lines.map((line) => ({
      id: line.id, productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, unitPricePaisa: line.unitPricePaisa,
      leftMilli: Math.floor((parseQuantity(line.billableBase) * 1000) / parseQuantity(line.factorToBase)),
    }));
  }
  return source.quotation.lines.map((line) => ({
    id: line.id, productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, unitPricePaisa: line.unitPricePaisa,
    leftMilli: Math.floor(((parseQuantity(line.qtyBase) - parseQuantity(line.convertedBase)) * 1000) / parseQuantity(line.factorToBase)),
  }));
}

/**
 * Writes a back-office invoice for part or all of an order (what has been delivered and not billed) or a quotation (the goods leave
 * with the invoice), at the agreed prices. The customer pays it later; terms set the due date.
 */
export function MakeInvoicePanel({ source }: { source: Source }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rows = billableOf(source);
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((row) => [row.id, formatQuantity(Math.max(0, row.leftMilli))])));
  const [terms, setTerms] = useState("");
  const [customerPo, setCustomerPo] = useState(source.kind === "order" ? source.order.customerPo : "");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(`inv-${crypto.randomUUID()}`);

  const left = rows.filter((row) => row.leftMilli > 0);
  const needsCustomer = source.kind === "quotation" && source.quotation.isProspect;
  if (!left.length) return null;
  const goodsLeave = source.kind === "quotation";
  if (!open) return <div className="button-row"><button className="button primary" onClick={() => setOpen(true)}>Make an invoice</button></div>;

  async function submit() {
    setError("");
    const picks = left
      .map((row) => ({ lineId: row.id, quantity: (quantities[row.id] ?? "").trim() }))
      .filter((pick) => pick.quantity !== "" && parseQuantity(pick.quantity) > 0);
    if (!picks.length) return setError("Enter how many of at least one item to bill");
    if (needsCustomer && !customer) return setError("This quotation is for a prospect. Choose the customer the invoice is for.");
    const input = {
      ...(source.kind === "order" ? { orderId: source.order.id } : { quotationId: source.quotation.id, customerId: needsCustomer ? customer?.id ?? null : null }),
      picks, ...(terms !== "" ? { termsDays: Number(terms) } : {}), customerPo, note,
    };
    const checked = salesInvoiceSchema.safeParse(input);
    if (!checked.success) return setError(checked.error.issues[0].message);
    setBusy(true);
    try {
      const result = await postSalesInvoice(input, key.current);
      // Orders, quotations, stock and the customer's khata all moved.
      await Promise.all(["sales-order", "sales-orders", "quotation", "quotations", "stock", "sales-invoices", "customers", "customer-ledger"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/invoices/${result.invoice.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post the invoice");
      // A different attempt needs a different key, or the server would answer with the failed one.
      key.current = `inv-${crypto.randomUUID()}`;
      setBusy(false);
    }
  }

  return <section className="panel stack" aria-label="Make an invoice">
    <h2>Make an invoice</h2>
    <p className="muted">
      {goodsLeave
        ? "Prices are the quoted ones. The goods leave the shop with the invoice."
        : "Prices are the order's. Only goods that have been delivered and not yet billed can be billed; the stock already left with the delivery."}
      {" "}The customer pays later; the amount goes on their account.
    </p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {needsCustomer && <CustomerPicker value={customer} onChange={setCustomer} />}
    <div className="table-scroll"><table aria-label="Quantities to bill">
      <thead><tr><th>Item</th><th>Unit</th><th className="num">Price</th><th className="num">Can be billed</th><th>Bill now</th></tr></thead>
      <tbody>{left.map((row) => <tr key={row.id}>
        <td>{row.productName}{row.variantName ? ` — ${row.variantName}` : ""}<small className="block muted">{row.sku}</small></td>
        <td>{row.unitName}</td><td className="num">{formatPkr(row.unitPricePaisa)}</td><td className="num">{formatQuantity(row.leftMilli)}</td>
        <td><QuantityInput aria-label={`Bill now ${row.sku}`} value={quantities[row.id] ?? ""} onChange={(event) => setQuantities({ ...quantities, [row.id]: event.target.value })} /></td>
      </tr>)}</tbody>
    </table></div>
    <div className="form-grid">
      <Field label="Payment terms">
        <SelectInput value={terms} onChange={(event) => setTerms(event.target.value)}>
          <option value="">The customer's usual terms</option>
          {paymentTermChoices.map((days) => <option key={days} value={days}>{days === 0 ? "Due on receipt" : `${days} days`}</option>)}
        </SelectInput>
      </Field>
      <Field label="Customer's PO number"><TextInput value={customerPo} maxLength={100} onChange={(event) => setCustomerPo(event.target.value)} /></Field>
      <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
    </div>
    <div className="button-row">
      <button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? "Posting…" : "Post invoice"}</button>
      <button className="button secondary" disabled={busy} onClick={() => setOpen(false)}>Not now</button>
    </div>
  </section>;
}
