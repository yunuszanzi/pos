import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { convertQuotationSchema } from "../../../shared/schemas/salesOrders";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import type { Quotation } from "../../api/quotationsApi";
import { postQuotationConversion } from "../../api/salesOrdersApi";
import { ErrorMessage, Field, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";
import { CustomerPicker, type PickedCustomer } from "../customers/CustomerPicker";

/** What is still to be ordered on a quotation line, in the unit it was quoted in (thousandths). */
const remainingMilli = (line: Quotation["lines"][number]) =>
  Math.floor(((parseQuantity(line.qtyBase) - parseQuantity(line.convertedBase)) * 1000) / parseQuantity(line.factorToBase));

/** Turns a quotation into a sales order, in whole or in part, at the quoted prices (FR-QUO-04). */
export function ConvertToOrderPanel({ quotation }: { quotation: Quotation }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(quotation.lines.map((line) => [line.id, formatQuantity(remainingMilli(line))])));
  const [customerPo, setCustomerPo] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(`conv-${crypto.randomUUID()}`);

  const left = quotation.lines.filter((line) => remainingMilli(line) > 0);
  if (!left.length) return null;
  if (!open) return <div className="button-row"><button className="button primary" onClick={() => setOpen(true)}>Make a sales order</button></div>;

  async function submit() {
    setError("");
    const picks = left
      .map((line) => ({ quotationLineId: line.id, quantity: (quantities[line.id] ?? "").trim() }))
      .filter((pick) => pick.quantity !== "" && parseQuantity(pick.quantity) > 0);
    if (!picks.length) return setError("Enter how many of at least one item to order");
    if (quotation.isProspect && !customer) return setError("This quotation is for a prospect. Choose the customer the order is for.");
    const input = { customerId: quotation.isProspect ? customer?.id ?? null : null, picks, customerPo, deliveryDate: deliveryDate || null, deliveryAddress };
    const checked = convertQuotationSchema.safeParse(input);
    if (!checked.success) return setError(checked.error.issues[0].message);
    setBusy(true);
    try {
      const result = await postQuotationConversion(quotation.id, input, key.current);
      await Promise.all(["quotations", "quotation", "sales-orders", "stock"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/sales-orders/${result.order.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not make the order");
      // A different attempt needs a different key, or the server would answer with the failed one.
      key.current = `conv-${crypto.randomUUID()}`;
      setBusy(false);
    }
  }

  return <section className="panel stack" aria-label="Make a sales order">
    <h2>Make a sales order</h2>
    <p className="muted">Prices are the quoted ones, whatever the shelf price is now. Lower a quantity to order only part of the quotation; the rest can be ordered later.</p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {quotation.isProspect && <CustomerPicker value={customer} onChange={setCustomer} />}
    <div className="table-scroll"><table aria-label="Quantities to order">
      <thead><tr><th>Item</th><th>Unit</th><th className="num">Quoted price</th><th className="num">Still to order</th><th>Order now</th></tr></thead>
      <tbody>{left.map((line) => <tr key={line.id}>
        <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
        <td>{line.unitName}</td><td className="num">{formatPkr(line.unitPricePaisa)}</td><td className="num">{formatQuantity(remainingMilli(line))}</td>
        <td><QuantityInput aria-label={`Order now ${line.sku}`} value={quantities[line.id] ?? ""} onChange={(event) => setQuantities({ ...quantities, [line.id]: event.target.value })} /></td>
      </tr>)}</tbody>
    </table></div>
    <div className="form-grid">
      <Field label="Customer's PO number"><TextInput value={customerPo} maxLength={100} onChange={(event) => setCustomerPo(event.target.value)} /></Field>
      <Field label="Deliver by"><TextInput type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} /></Field>
      <Field label="Deliver to"><TextInput value={deliveryAddress} maxLength={500} onChange={(event) => setDeliveryAddress(event.target.value)} /></Field>
    </div>
    <div className="button-row">
      <button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Create sales order"}</button>
      <button className="button secondary" disabled={busy} onClick={() => setOpen(false)}>Not now</button>
    </div>
  </section>;
}
