import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatPkr, toPlainRupees } from "../../../shared/money";
import { purchaseLineValue, unitCostFromBase } from "../../../shared/purchasing";
import { purchaseOrderSchema } from "../../../shared/schemas/purchasing";
import { parseQuantity } from "../../../shared/units";
import { getAllUnits } from "../../api/catalogueApi";
import { getAllLocations } from "../../api/orgApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { createPurchaseOrder, getPurchaseHistory, getPurchaseOrderById, updatePurchaseOrder, type PurchaseHistory, type PurchaseOrder } from "../../api/purchasingApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { QuantityInput } from "../../app/QuantityInput";
import { amountOf } from "../../pos/amounts";
import { ProductPicker } from "../products/ProductPicker";
import { SupplierPicker, type PickedSupplier } from "../suppliers/SupplierPicker";
import { momentDayText } from "./dayText";

type UnitChoice = { unitId: string; name: string; factorMilli: number };
type Line = {
  variantId: string; sku: string; productName: string; variantName: string;
  unitId: string; units: UnitChoice[]; quantity: string; cost: string;
  /** What the price box held when it was last filled in for the unit, so a changed unit only replaces a suggestion, never a typed price. */
  suggested: string;
  costPerBasePaisa: number;
  /** What the SKU cost the last few times it was bought, once it has loaded. */
  history?: PurchaseHistory;
};

/** Writes a purchase order, or changes one that is still a draft. */
export function PurchaseOrderFormPage() {
  const { id } = useParams();
  const existing = useQuery({ queryKey: ["purchase-order", id], queryFn: () => getPurchaseOrderById(id!), enabled: Boolean(id), staleTime: 0 });
  if (id && existing.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (id && existing.isError) return <div className="content"><ErrorMessage>{existing.error.message}</ErrorMessage></div>;
  if (existing.data && existing.data.status !== "draft") return <div className="content"><ErrorMessage>Only a draft order can be changed. Cancel this order and write a new one.</ErrorMessage></div>;
  return <OrderForm order={existing.data} />;
}

function OrderForm({ order }: { order?: PurchaseOrder }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const [supplier, setSupplier] = useState<PickedSupplier | null>(order ? { id: order.supplierId, name: order.supplierName } : null);
  const [locationId, setLocationId] = useState(order?.locationId ?? "");
  const [expectedDate, setExpectedDate] = useState(order?.expectedDate ?? "");
  const [note, setNote] = useState(order?.note ?? "");
  const [lines, setLines] = useState<Line[]>(() => (order?.lines ?? []).map((line) => ({
    variantId: line.variantId, sku: line.sku, productName: line.productName, variantName: line.variantName, unitId: line.unitId,
    // A line already written keeps its unit; to buy it in another unit, remove it and add it again.
    units: [{ unitId: line.unitId, name: line.unitName, factorMilli: parseQuantity(line.factorToBase) }], quantity: line.quantity,
    cost: toPlainRupees(line.unitCostPaisa ?? 0), suggested: "", costPerBasePaisa: 0,
  })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const activeLocations = (locations.data ?? []).filter((location) => location.active);
  // Until the person picks one, the first location is used.
  const chosenLocationId = locationId || activeLocations[0]?.id || "";

  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";
  const priceFor = (variantCost: number, factorMilli: number) => toPlainRupees(unitCostFromBase(variantCost, factorMilli));

  function addLine(product: Product, variant: ProductVariant) {
    if (lines.some((line) => line.variantId === variant.id)) return;
    const choices = variant.units.map((unit) => ({ unitId: unit.unitId, name: unitName(unit.unitId), factorMilli: parseQuantity(unit.factorToBase) }));
    const first = choices.find((choice) => variant.units.find((unit) => unit.unitId === choice.unitId)?.isBase) ?? choices[0];
    const suggested = priceFor(variant.costPaisa ?? 0, first.factorMilli);
    setLines([...lines, { variantId: variant.id, sku: variant.sku, productName: product.name, variantName: variant.variantName, unitId: first.unitId, units: choices, quantity: "", cost: suggested, suggested, costPerBasePaisa: variant.costPaisa ?? 0 }]);
    // What it cost last time (the billed price when billed) is a better price to start from than the SKU's cost. A price already typed is kept.
    void getPurchaseHistory(variant.id).then((history) => setLines((current) => current.map((line) => {
      if (line.variantId !== variant.id) return line;
      if (history.lastCostPerBasePaisa === null) return { ...line, history };
      const factor = line.units.find((unit) => unit.unitId === line.unitId)?.factorMilli ?? 1000;
      const better = priceFor(history.lastCostPerBasePaisa, factor);
      return { ...line, history, costPerBasePaisa: history.lastCostPerBasePaisa, suggested: better, cost: line.cost === line.suggested ? better : line.cost };
    }))).catch(() => undefined);
  }
  const change = (index: number, patch: Partial<Line>) => setLines(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  function changeUnit(index: number, unitId: string) {
    const line = lines[index];
    const factor = line.units.find((unit) => unit.unitId === unitId)?.factorMilli ?? 1000;
    const suggested = line.costPerBasePaisa ? priceFor(line.costPerBasePaisa, factor) : line.suggested;
    change(index, { unitId, suggested, cost: line.cost === line.suggested ? suggested : line.cost });
  }

  const valueOf = (line: Line) => {
    const paisa = amountOf(line.cost);
    try {
      return paisa === null || !line.quantity ? 0 : purchaseLineValue(parseQuantity(line.quantity), paisa);
    } catch {
      return 0;
    }
  };
  const total = lines.reduce((sum, line) => sum + valueOf(line), 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!supplier) return setError("Choose the supplier");
    const costs = lines.map((line) => amountOf(line.cost));
    if (costs.some((value) => value === null)) return setError("A price is not a valid amount. Use rupees with up to two decimals, for example 3200.00");
    const input = {
      supplierId: supplier.id, locationId: chosenLocationId, expectedDate: expectedDate || null, note,
      lines: lines.map((line, index) => ({ variantId: line.variantId, unitId: line.unitId, quantity: line.quantity.trim(), unitCostPaisa: costs[index]! })),
    };
    const checked = purchaseOrderSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      const line = issue.path[0] === "lines" && typeof issue.path[1] === "number" ? lines[issue.path[1]] : undefined;
      return setError(`${line ? `${line.sku}: ` : ""}${issue.message}`);
    }
    setBusy(true);
    try {
      const saved = order ? await updatePurchaseOrder(order.id, input) : await createPurchaseOrder(input);
      await Promise.all(["purchase-orders", "purchase-order"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/purchase-orders/${saved.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the order");
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title={order ? `Change ${order.number}` : "New purchase order"} description="Choose the supplier, add the items and the price of one unit of each. It stays a draft until you send it." />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <SupplierPicker value={supplier} onChange={setSupplier} />
          <Field label="Deliver to"><SelectInput value={chosenLocationId} onChange={(event) => setLocationId(event.target.value)} required>{activeLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</SelectInput></Field>
          <Field label="Expected on"><TextInput type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} /></Field>
          <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
        </div>
      </section>
      <section className="panel stack">
        <h2>Items</h2>
        <ProductPicker stockedOnly isPicked={(variantId) => lines.some((line) => line.variantId === variantId)} onPick={addLine} />
        {lines.map((line, index) => <div className="form-grid" key={line.variantId} role="group" aria-label={`Line ${line.sku}`}>
          <div><strong>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}</strong><br /><span className="mono">{line.sku}</span>
            {line.history?.entries[0] && <small className="block muted" data-testid={`last-bought-${line.sku}`}>Last bought {formatPkr(line.history.entries[0].unitCostPaisa)} a {line.history.entries[0].unitName.toLowerCase()} from {line.history.entries[0].supplierName} ({momentDayText(line.history.entries[0].receivedAt)}{line.history.entries[0].billed ? ", as billed" : ""})</small>}
            {line.history && line.history.entries.length > 1 && <small className="block muted">Before that: {line.history.entries.slice(1).map((entry) => `${formatPkr(entry.unitCostPaisa)} a ${entry.unitName.toLowerCase()}`).join(", ")}</small>}</div>
          <Field label="Quantity"><QuantityInput value={line.quantity} onChange={(event) => change(index, { quantity: event.target.value })} placeholder="0" required /></Field>
          <Field label="Unit"><SelectInput value={line.unitId} onChange={(event) => changeUnit(index, event.target.value)}>{line.units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unit.name}</option>)}</SelectInput></Field>
          <Field label="Price of one unit (Rs)"><MoneyInput value={line.cost} onChange={(event) => change(index, { cost: event.target.value })} /></Field>
          <div><span className="muted">Line total</span><br /><strong>{formatPkr(valueOf(line))}</strong></div>
          <button className="text-button" type="button" onClick={() => setLines(lines.filter((_, position) => position !== index))}>Remove line</button>
        </div>)}
        {!lines.length && <p className="muted">No items added yet.</p>}
        {lines.length > 0 && <p className="pay-total"><span>Order total</span><strong data-testid="order-total">{formatPkr(total)}</strong></p>}
      </section>
      <div className="button-row">
        <button className="button primary" disabled={busy || !lines.length || !supplier}>{busy ? "Saving…" : "Save order"}</button>
        <Link className="button secondary" to={order ? `/purchase-orders/${order.id}` : "/purchase-orders"}>Cancel</Link>
      </div>
    </form>
  </div>;
}
