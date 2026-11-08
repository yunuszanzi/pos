import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { formatPkr, toPlainRupees } from "../../../shared/money";
import { purchaseLineValue, unitCostFromBase } from "../../../shared/purchasing";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { goodsReceiptSchema } from "../../../shared/schemas/purchasing";
import { parseQuantity } from "../../../shared/units";
import { getAllUnits } from "../../api/catalogueApi";
import { getAllLocations } from "../../api/orgApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { getPurchaseOrderById, postGoodsReceipt, type PostedReceipt, type PurchaseOrder } from "../../api/purchasingApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { useCan } from "../../app/permissions";
import { QuantityInput } from "../../app/QuantityInput";
import { amountOf } from "../../pos/amounts";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { ProductPicker } from "../products/ProductPicker";
import { SupplierPicker, type PickedSupplier } from "../suppliers/SupplierPicker";
import { usePrintSetup } from "./usePrintSetup";

/** Receives goods against an order (the lines still to come) or, with no `?order=`, goods that arrived with no order. */
export function ReceiveGoodsPage() {
  const [params] = useSearchParams();
  const orderId = params.get("order");
  const order = useQuery({ queryKey: ["purchase-order", orderId], queryFn: () => getPurchaseOrderById(orderId!), enabled: Boolean(orderId), staleTime: 0 });
  if (orderId && order.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (orderId && order.isError) return <div className="content"><ErrorMessage>{order.error.message}</ErrorMessage></div>;
  return <ReceiveForm order={order.data} />;
}

type OrderRow = { orderLineId: string; label: string; sku: string; unitName: string; remaining: string; quantity: string; cost: string };
type DirectRow = {
  variantId: string; label: string; sku: string; unitId: string; units: Array<{ unitId: string; name: string; factorMilli: number }>; quantity: string; cost: string; suggested: string; costPerBasePaisa: number;
};

function ReceiveForm({ order }: { order?: PurchaseOrder }) {
  const queryClient = useQueryClient();
  const mayPrice = useCan("products.cost.view");
  const setup = usePrintSetup();
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const [supplier, setSupplier] = useState<PickedSupplier | null>(order ? { id: order.supplierId, name: order.supplierName } : null);
  const [locationId, setLocationId] = useState(order?.locationId ?? "");
  const [supplierRef, setSupplierRef] = useState("");
  const [note, setNote] = useState("");
  // Against an order, each line is offered with what is still to come; without one the lines are picked.
  const [orderRows, setOrderRows] = useState<OrderRow[]>(() => (order?.lines ?? []).filter((line) => parseQuantity(line.remainingQuantity) > 0).map((line) => ({
    orderLineId: line.id, label: line.variantName ? `${line.productName} — ${line.variantName}` : line.productName, sku: line.sku, unitName: line.unitName,
    remaining: line.remainingQuantity, quantity: line.remainingQuantity, cost: toPlainRupees(line.unitCostPaisa ?? 0),
  })));
  const [directRows, setDirectRows] = useState<DirectRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PostedReceipt | null>(null);
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  // One key for this form: a double click or a retry after a dropped connection receives the goods once.
  const key = useRef(`receipt-${crypto.randomUUID()}`);

  const activeLocations = (locations.data ?? []).filter((location) => location.active);
  // Until the person picks one, the first location is used.
  const chosenLocationId = locationId || activeLocations[0]?.id || "";
  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";

  function addDirect(product: Product, variant: ProductVariant) {
    if (directRows.some((row) => row.variantId === variant.id)) return;
    const choices = variant.units.map((unit) => ({ unitId: unit.unitId, name: unitName(unit.unitId), factorMilli: parseQuantity(unit.factorToBase) }));
    const base = choices.find((choice) => variant.units.find((unit) => unit.unitId === choice.unitId)?.isBase) ?? choices[0];
    const suggested = toPlainRupees(unitCostFromBase(variant.costPaisa ?? 0, base.factorMilli));
    setDirectRows([...directRows, { variantId: variant.id, label: variant.variantName ? `${product.name} — ${variant.variantName}` : product.name, sku: variant.sku, unitId: base.unitId, units: choices, quantity: "", cost: suggested, suggested, costPerBasePaisa: variant.costPaisa ?? 0 }]);
  }
  const changeDirect = (index: number, patch: Partial<DirectRow>) => setDirectRows(directRows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  function changeDirectUnit(index: number, unitId: string) {
    const row = directRows[index];
    const factor = row.units.find((unit) => unit.unitId === unitId)?.factorMilli ?? 1000;
    const suggested = row.costPerBasePaisa ? toPlainRupees(unitCostFromBase(row.costPerBasePaisa, factor)) : row.suggested;
    changeDirect(index, { unitId, suggested, cost: row.cost === row.suggested ? suggested : row.cost });
  }
  const changeOrder = (index: number, patch: Partial<OrderRow>) => setOrderRows(orderRows.map((row, position) => (position === index ? { ...row, ...patch } : row)));

  const valueOf = (quantity: string, cost: string) => {
    const paisa = amountOf(cost);
    try {
      return paisa === null || !quantity ? 0 : purchaseLineValue(parseQuantity(quantity), paisa);
    } catch {
      return 0;
    }
  };
  const total = order
    ? orderRows.reduce((sum, row) => sum + valueOf(row.quantity, row.cost), 0)
    : directRows.reduce((sum, row) => sum + valueOf(row.quantity, row.cost), 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!supplier) return setError("Choose the supplier");
    const input = order
      ? {
        supplierId: supplier.id, locationId: chosenLocationId, orderId: order.id, supplierRef, note,
        lines: orderRows.filter((row) => row.quantity.trim() && parseQuantity(row.quantity) > 0).map((row) => ({
          orderLineId: row.orderLineId, quantity: row.quantity.trim(), ...(mayPrice && amountOf(row.cost) !== null ? { unitCostPaisa: amountOf(row.cost)! } : {}),
        })),
      }
      : {
        supplierId: supplier.id, locationId: chosenLocationId, orderId: null, supplierRef, note,
        lines: directRows.map((row) => ({ variantId: row.variantId, unitId: row.unitId, quantity: row.quantity.trim(), unitCostPaisa: amountOf(row.cost) ?? Number.NaN })),
      };
    const checked = goodsReceiptSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      return setError(issue.path[0] === "lines" && issue.path[2] === "unitCostPaisa" ? "A price is not a valid amount. Use rupees with up to two decimals, for example 3200.00" : issue.message);
    }
    setBusy(true);
    try {
      const posted = await postGoodsReceipt(input, key.current);
      await Promise.all(["purchase-order", "purchase-orders", "goods-receipts", "stock"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      setDone(posted);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not receive the goods");
      setBusy(false);
    }
  }

  function print(posted: PostedReceipt) {
    if (!setup) return;
    const { receipt } = posted;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat,
      goodsReceipt: {
        number: receipt.number, receivedAt: receipt.receivedAt, supplierName: receipt.supplierName, branchName: receipt.branchName, locationName: receipt.locationName,
        orderNumber: receipt.orderNumber, supplierRef: receipt.supplierRef, receivedBy: receipt.receivedBy, note: receipt.note,
        ...(receipt.totalPaisa !== undefined ? { totalPaisa: receipt.totalPaisa } : {}),
        lines: receipt.lines.map((line) => ({
          productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity,
          ...(line.unitCostPaisa !== undefined ? { unitCostPaisa: line.unitCostPaisa, lineTotalPaisa: line.lineValuePaisa } : {}),
        })),
      },
    });
  }

  if (done) {
    const { receipt, stock } = done;
    return <div className="content">
      <PageTitle title="Goods received" description={`${receipt.number} from ${receipt.supplierName}${receipt.orderNumber ? `, against ${receipt.orderNumber}` : ""}.`} />
      <section className="panel stack">
        {receipt.totalPaisa !== undefined && <dl className="totals"><div className="grand"><dt>Value received</dt><dd data-testid="receipt-total">{formatPkr(receipt.totalPaisa)}</dd></div></dl>}
        <div className="table-scroll"><table aria-label="Stock now">
          <thead><tr><th>Item</th><th className="num">Received</th><th className="num">On hand now</th>{stock.some((row) => row.averageCostPaisa !== undefined) && <th className="num">Average cost</th>}</tr></thead>
          <tbody>
            {receipt.lines.map((line) => {
              const now = stock.find((row) => row.variantId === line.variantId);
              return <tr key={line.id}>
                <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
                <td className="num">{line.quantity} {line.unitName}</td><td className="num" data-testid={`on-hand-${line.sku}`}>{now?.onHand}</td>
                {now?.averageCostPaisa !== undefined && <td className="num">{formatPkr(now.averageCostPaisa)}</td>}
              </tr>;
            })}
          </tbody>
        </table></div>
        {setup && <div className="pay-row">
          <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
            {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
          </SelectInput>
          <button className="button secondary" onClick={() => print(done)}>Print receipt</button>
        </div>}
        <div className="button-row">
          {receipt.orderId && <Link className="button primary" to={`/purchase-orders/${receipt.orderId}`}>Back to the order</Link>}
          <Link className="button secondary" to="/goods-receipts">All receipts</Link>
        </div>
      </section>
      <ReceiptPrinter job={job} onDone={() => setJob(null)} />
    </div>;
  }

  const directBlocked = !order && !mayPrice;
  return <div className="content">
    <PageTitle title={order ? `Receive goods for ${order.number}` : "Receive goods without an order"}
      description={order ? "Enter how many of each item arrived. Leave a line at 0 if it did not come. The rest stays on the order." : "For goods that arrived with no order. Choose the supplier, add the items and the price of one unit of each."} />
    {directBlocked && <ErrorMessage>You need permission to see costs to receive goods without an order. Receive them against an order instead.</ErrorMessage>}
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <SupplierPicker value={supplier} onChange={setSupplier} disabled={Boolean(order)} />
          <Field label="Receive into"><SelectInput value={chosenLocationId} onChange={(event) => setLocationId(event.target.value)} required>{activeLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</SelectInput></Field>
          <Field label="Supplier's challan or invoice number"><TextInput value={supplierRef} maxLength={100} onChange={(event) => setSupplierRef(event.target.value)} /></Field>
          <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
        </div>
      </section>

      <section className="panel stack">
        <h2>Items</h2>
        {order && orderRows.map((row, index) => <div className="form-grid" key={row.orderLineId} role="group" aria-label={`Line ${row.sku}`}>
          <div><strong>{row.label}</strong><br /><span className="mono">{row.sku}</span><small className="block muted">{row.remaining} {row.unitName} still to come</small></div>
          <Field label={`Received (${row.unitName})`}><QuantityInput value={row.quantity} onChange={(event) => changeOrder(index, { quantity: event.target.value })} placeholder="0" /></Field>
          {mayPrice && <Field label="Price of one unit (Rs)"><MoneyInput value={row.cost} onChange={(event) => changeOrder(index, { cost: event.target.value })} /></Field>}
          {mayPrice && <div><span className="muted">Value</span><br /><strong>{formatPkr(valueOf(row.quantity, row.cost))}</strong></div>}
        </div>)}
        {order && orderRows.length === 0 && <p className="muted">Everything on this order has been received.</p>}
        {!order && <>
          <ProductPicker stockedOnly isPicked={(variantId) => directRows.some((row) => row.variantId === variantId)} onPick={addDirect} />
          {directRows.map((row, index) => <div className="form-grid" key={row.variantId} role="group" aria-label={`Line ${row.sku}`}>
            <div><strong>{row.label}</strong><br /><span className="mono">{row.sku}</span></div>
            <Field label="Quantity"><QuantityInput value={row.quantity} onChange={(event) => changeDirect(index, { quantity: event.target.value })} placeholder="0" required /></Field>
            <Field label="Unit"><SelectInput value={row.unitId} onChange={(event) => changeDirectUnit(index, event.target.value)}>{row.units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unit.name}</option>)}</SelectInput></Field>
            <Field label="Price of one unit (Rs)"><MoneyInput value={row.cost} onChange={(event) => changeDirect(index, { cost: event.target.value })} /></Field>
            <div><span className="muted">Value</span><br /><strong>{formatPkr(valueOf(row.quantity, row.cost))}</strong></div>
            <button className="text-button" type="button" onClick={() => setDirectRows(directRows.filter((_, position) => position !== index))}>Remove line</button>
          </div>)}
          {!directRows.length && <p className="muted">No items added yet.</p>}
        </>}
        {mayPrice && total > 0 && <p className="pay-total"><span>Value received</span><strong data-testid="receipt-value">{formatPkr(total)}</strong></p>}
      </section>
      <div className="button-row">
        <button className="button primary" disabled={busy || directBlocked || !supplier || (order ? orderRows.length === 0 : directRows.length === 0)}>{busy ? "Receiving…" : "Receive goods"}</button>
        <Link className="button secondary" to={order ? `/purchase-orders/${order.id}` : "/purchase-orders"}>Cancel</Link>
      </div>
    </form>
  </div>;
}
