import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { formatPkr, parsePercentToBps, toPlainRupees } from "../../../shared/money";
import { priceCart } from "../../../shared/pricing";
import { salesOrderSchema } from "../../../shared/schemas/salesOrders";
import { parseQuantity } from "../../../shared/units";
import { getAllUnits } from "../../api/catalogueApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { postSalesOrder } from "../../api/salesOrdersApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { QuantityInput } from "../../app/QuantityInput";
import { amountOf } from "../../pos/amounts";
import { CustomerPicker, type PickedCustomer } from "../customers/CustomerPicker";
import { ProductPicker } from "../products/ProductPicker";

type UnitChoice = { unitId: string; name: string; salePricePaisa: number };
type Line = { variantId: string; sku: string; productName: string; variantName: string; unitId: string; units: UnitChoice[]; quantity: string; price: string; discount: string };

/** Takes a sales order for a customer: the items, the prices (the customer's tier unless changed) and where and when it goes. */
export function SalesOrderFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [customerPo, setCustomerPo] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for this order, so a retry after a dropped connection cannot take it (and reserve its stock) twice.
  const key = useRef(`so-${crypto.randomUUID()}`);

  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";
  function addLine(product: Product, variant: ProductVariant) {
    if (lines.some((line) => line.variantId === variant.id)) return;
    const choices = variant.units.map((unit) => ({ unitId: unit.unitId, name: unitName(unit.unitId), salePricePaisa: unit.salePricePaisa }));
    const first = choices.find((choice) => variant.units.find((unit) => unit.unitId === choice.unitId)?.isBase) ?? choices[0];
    setLines([...lines, { variantId: variant.id, sku: variant.sku, productName: product.name, variantName: variant.variantName, unitId: first.unitId, units: choices, quantity: "", price: "", discount: "" }]);
  }
  const change = (index: number, patch: Partial<Line>) => setLines(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));

  /** An estimate at the price typed or the shelf price; the server works out the real figure (tier, tax) when it takes the order. */
  const estimate = (line: Line) => {
    try {
      const price = line.price ? amountOf(line.price) : line.units.find((unit) => unit.unitId === line.unitId)?.salePricePaisa ?? 0;
      if (price === null || !line.quantity) return 0;
      const discount = line.discount ? { type: "percent" as const, bps: parsePercentToBps(line.discount) } : null;
      return priceCart({ taxMode: "exclusive", lines: [{ qtyMilli: parseQuantity(line.quantity), unitPricePaisa: price, taxRateBps: 0, discount }] }).totalPaisa;
    } catch {
      return 0;
    }
  };
  const subtotal = lines.reduce((sum, line) => sum + estimate(line), 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!customer) return setError("Choose the customer");
    const prices = lines.map((line) => (line.price ? amountOf(line.price) : undefined));
    if (prices.some((value) => value === null)) return setError("A price is not a valid amount. Use rupees with up to two decimals, for example 3200.00");
    let discounts;
    try {
      discounts = lines.map((line) => (line.discount ? { type: "percent" as const, bps: parsePercentToBps(line.discount) } : null));
    } catch {
      return setError("A discount must be a percentage between 0 and 100, for example 5 or 7.5");
    }
    const input = {
      customerId: customer.id, customerPo, deliveryDate: deliveryDate || null, deliveryAddress, note,
      lines: lines.map((line, index) => ({
        variantId: line.variantId, unitId: line.unitId, quantity: line.quantity.trim(),
        ...(prices[index] !== undefined ? { unitPricePaisa: prices[index]! } : {}), discount: discounts[index],
      })),
    };
    const checked = salesOrderSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      const line = issue.path[0] === "lines" && typeof issue.path[1] === "number" ? lines[issue.path[1]] : undefined;
      return setError(`${line ? `${line.sku}: ` : ""}${issue.message}`);
    }
    setBusy(true);
    try {
      const result = await postSalesOrder(input, key.current);
      // Stock reserved changed: the stock lists and order lists must be asked again.
      await Promise.all(["sales-orders", "stock"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/sales-orders/${result.order.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not take the order");
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="New sales order" description="Choose the customer and the items. Taking the order holds the stock for it; nothing leaves until it is dispatched." />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <CustomerPicker value={customer} onChange={setCustomer} />
          <Field label="Customer's PO number"><TextInput value={customerPo} maxLength={100} onChange={(event) => setCustomerPo(event.target.value)} /></Field>
          <Field label="Deliver by"><TextInput type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} /></Field>
          <Field label="Deliver to"><TextInput value={deliveryAddress} maxLength={500} onChange={(event) => setDeliveryAddress(event.target.value)} /></Field>
          <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
        </div>
      </section>
      <section className="panel stack">
        <h2>Items</h2>
        <ProductPicker isPicked={(variantId) => lines.some((line) => line.variantId === variantId)} onPick={addLine} />
        {lines.map((line, index) => <div className="form-grid" key={line.variantId} role="group" aria-label={`Line ${line.sku}`}>
          <div><strong>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}</strong><br /><span className="mono">{line.sku}</span></div>
          <Field label="Quantity"><QuantityInput value={line.quantity} onChange={(event) => change(index, { quantity: event.target.value })} placeholder="0" required /></Field>
          <Field label="Unit"><SelectInput value={line.unitId} onChange={(event) => change(index, { unitId: event.target.value })}>{line.units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unit.name}</option>)}</SelectInput></Field>
          <Field label="Price of one unit (Rs)"><MoneyInput value={line.price} placeholder={toPlainRupees(line.units.find((unit) => unit.unitId === line.unitId)?.salePricePaisa ?? 0)} onChange={(event) => change(index, { price: event.target.value })} /></Field>
          <Field label="Discount (%)"><QuantityInput value={line.discount} onChange={(event) => change(index, { discount: event.target.value })} placeholder="0" /></Field>
          <div><span className="muted">About</span><br /><strong>{formatPkr(estimate(line))}</strong></div>
          <button className="text-button" type="button" onClick={() => setLines(lines.filter((_, position) => position !== index))}>Remove line</button>
        </div>)}
        {!lines.length && <p className="muted">No items added yet.</p>}
        {lines.length > 0 && <>
          <p className="pay-total"><span>Items, about</span><strong data-testid="order-estimate">{formatPkr(subtotal)}</strong></p>
          <p className="muted">Leave a price empty to use the shelf price (or the customer's price tier). Tax and the exact total are worked out when the order is taken.</p>
        </>}
      </section>
      <div className="button-row">
        <button className="button primary" disabled={busy || !lines.length || !customer}>{busy ? "Saving…" : "Take order"}</button>
        <Link className="button secondary" to="/sales-orders">Cancel</Link>
      </div>
    </form>
  </div>;
}
