import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { whatsappShareLink } from "../../../shared/khata";
import { formatPkr } from "../../../shared/money";
import { reorderMessage } from "../../../shared/purchasing";
import { parseQuantity } from "../../../shared/units";
import { createDraftOrdersFromReorder, getReorderList, type DraftOrdersResult, type ReorderRow } from "../../api/purchasingApi";
import { getAllLocations } from "../../api/orgApi";
import { getAllSuppliers } from "../../api/suppliersApi";
import { ErrorMessage, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { QuantityInput } from "../../app/QuantityInput";
import { usePrintSetup } from "./usePrintSetup";

const pageSize = 25;
type Choice = { checked?: boolean; quantity?: string; supplierId?: string; remember?: boolean };

/**
 * What is running low: stock at or below its reorder level, counting orders already on their way. Tick items, check the quantity and the
 * supplier, and turn them into draft purchase orders, one per supplier. The list can also be shared on WhatsApp.
 */
export function ReorderPage() {
  const queryClient = useQueryClient();
  const mayOrder = useCan("purchasing.order");
  const seesCosts = useCan("products.cost.view");
  const setup = usePrintSetup();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  // What the person chose, by SKU. It survives paging; an untouched row uses what the list suggested.
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [locationId, setLocationId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<DraftOrdersResult | null>(null);
  // One key per attempt: a double click or a retry after a dropped connection makes the orders once. A change makes a new attempt.
  const attempt = useRef({ key: `reorder-${crypto.randomUUID()}`, body: "" });

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({ queryKey: ["reorder-list", { search, page }], queryFn: ({ signal }) => getReorderList({ q: search, page, pageSize }, signal), placeholderData: keepPreviousData });
  const suppliers = useQuery({ queryKey: ["suppliers", { picker: "all" }], queryFn: ({ signal }) => getAllSuppliers({ pageSize: 100 }, signal), staleTime: 5 * 60_000 });
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const activeLocations = (locations.data ?? []).filter((location) => location.active);
  const chosenLocationId = locationId || activeLocations[0]?.id || "";

  const rowChoice = (row: ReorderRow) => {
    const choice = choices[row.variantId] ?? {};
    return { checked: choice.checked ?? false, quantity: choice.quantity ?? row.suggestedQuantity, supplierId: choice.supplierId ?? row.supplier?.id ?? "", remember: choice.remember ?? false };
  };
  const change = (variantId: string, patch: Choice) => setChoices({ ...choices, [variantId]: { ...choices[variantId], ...patch } });
  const picked = rows.filter((row) => rowChoice(row).checked);
  const allTicked = rows.length > 0 && picked.length === rows.length;

  async function create() {
    setError("");
    const lines = [];
    for (const row of picked) {
      const choice = rowChoice(row);
      if (!choice.supplierId) return setError(`Choose a supplier for ${row.productName}${row.variantName ? ` — ${row.variantName}` : ""}`);
      try {
        if (parseQuantity(choice.quantity) <= 0) throw new Error("zero");
      } catch {
        return setError(`Enter how many ${row.productName} to order`);
      }
      lines.push({ variantId: row.variantId, supplierId: choice.supplierId, quantity: choice.quantity, remember: choice.remember });
    }
    const body = JSON.stringify({ locationId: chosenLocationId, lines });
    if (attempt.current.body !== body) attempt.current = { key: `reorder-${crypto.randomUUID()}`, body };
    setBusy(true);
    try {
      const result = await createDraftOrdersFromReorder({ locationId: chosenLocationId, lines }, attempt.current.key);
      setMade(result);
      setChoices({});
      await Promise.all(["reorder-list", "purchase-orders"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not make the orders");
    } finally {
      setBusy(false);
    }
  }

  const share = rows.length
    ? whatsappShareLink(reorderMessage(setup?.business.tradeName ?? "Stock", rows.map((row) => ({
      name: row.variantName ? `${row.productName} — ${row.variantName}` : row.productName, sku: row.sku, onHand: row.onHand, suggested: rowChoice(row).quantity, unitName: row.baseUnitName,
    }))))
    : null;

  return <div className="content">
    <PageTitle title="Reorder list" description="Items at or below their reorder level, counting orders already on their way. The most short are first. Quantities are in pieces (the base unit); change the unit on the draft order." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {made && <SuccessMessage>
      Made {made.orders.length} draft {made.orders.length === 1 ? "order" : "orders"}:{" "}
      {made.orders.map((order, index) => <span key={order.id}>{index > 0 && ", "}<Link className="text-button" to={`/purchase-orders/${order.id}`}>{order.number}</Link> ({order.supplierName}, {order.lineCount} {order.lineCount === 1 ? "item" : "items"}{seesCosts ? `, ${formatPkr(order.totalPaisa)}` : ""})</span>)}.
      Change and send them from the purchase orders page.
    </SuccessMessage>}
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search the reorder list" placeholder="Product or SKU" value={text} onChange={(event) => setText(event.target.value)} />
        {mayOrder && <label className="field"><span>Receive into</span>
          <SelectInput aria-label="Receive into" value={chosenLocationId} onChange={(event) => setLocationId(event.target.value)}>
            {activeLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </SelectInput></label>}
      </div>
      <div className="button-row">
        {mayOrder && <button className="button primary" disabled={busy || picked.length === 0} onClick={() => void create()}>{busy ? "Making…" : `Make draft orders (${picked.length})`}</button>}
        {share && <a className="button secondary" href={share} target="_blank" rel="noreferrer">Share on WhatsApp</a>}
      </div>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Reorder list">
        <thead><tr>
          <th>{mayOrder && <input type="checkbox" aria-label="Tick every item on this page" checked={allTicked} onChange={(event) => setChoices({ ...choices, ...Object.fromEntries(rows.map((row) => [row.variantId, { ...choices[row.variantId], checked: event.target.checked }])) })} />}</th>
          <th>Item</th><th className="num">On hand</th><th className="num">On order</th><th className="num">Level</th>
          {mayOrder && <><th className="num">Order</th><th>Supplier</th></>}
        </tr></thead>
        <tbody>
          {rows.map((row) => {
            const choice = rowChoice(row);
            return <tr key={row.variantId}>
              <td>{mayOrder && <input type="checkbox" aria-label={`Order ${row.sku}`} checked={choice.checked} onChange={(event) => change(row.variantId, { checked: event.target.checked })} />}</td>
              <td>{row.productName}{row.variantName ? ` — ${row.variantName}` : ""}<small className="block muted">{row.sku}{row.lastCostPerBasePaisa !== undefined ? ` · last bought at ${formatPkr(row.lastCostPerBasePaisa)} a ${row.baseUnitName.toLowerCase()}` : ""}</small></td>
              <td className="num">{row.onHand}</td><td className="num">{row.onOrder === "0" ? "" : row.onOrder}</td><td className="num">{row.reorderLevel}</td>
              {mayOrder && <>
                <td className="num"><QuantityInput aria-label={`Quantity of ${row.sku} to order`} value={choice.quantity} onChange={(event) => change(row.variantId, { quantity: event.target.value })} /></td>
                <td>
                  <SelectInput aria-label={`Supplier for ${row.sku}`} value={choice.supplierId} onChange={(event) => change(row.variantId, { supplierId: event.target.value, remember: true })}>
                    <option value="">Choose…</option>
                    {(suppliers.data?.data ?? []).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                  </SelectInput>
                  {choice.supplierId && !(row.supplier?.preferred && row.supplier.id === choice.supplierId) && <label className="check"><input type="checkbox" checked={choice.remember} onChange={(event) => change(row.variantId, { remember: event.target.checked })} /> Usual supplier</label>}
                </td>
              </>}
            </tr>;
          })}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={mayOrder ? 7 : 5} className="muted">Nothing is running low.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "item" : "items"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
