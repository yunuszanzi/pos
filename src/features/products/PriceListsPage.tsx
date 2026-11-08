import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { parseRupees, toPlainRupees } from "../../../shared/money";
import { priceListSchema } from "../../../shared/schemas/catalogue";
import {
  createPriceList, getAllPriceLists, getAllUnits, getPriceListById, updatePriceList, type PriceListDetail,
} from "../../api/catalogueApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";
import { MoneyInput } from "../../app/MoneyInput";
import { useCan } from "../../app/permissions";
import { ProductPicker } from "./ProductPicker";

type Row = { key: string; variantId: string; sku: string; label: string; unitIds: string[]; unitId: string; minQuantity: string; price: string };

const rowsOf = (detail: PriceListDetail | null): Row[] => (detail?.items ?? []).map((item) => ({
  key: item.id, variantId: item.variantId, sku: item.sku, label: item.productName + (item.variantName ? ` · ${item.variantName}` : ""),
  unitIds: item.unitIds, unitId: item.unitId, minQuantity: item.minQuantity, price: toPlainRupees(item.pricePaisa),
}));

export function PriceListsPage() {
  const canManage = useCan("catalog.manage");
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id") ?? "";
  const creating = params.get("new") === "1";
  const [notice, setNotice] = useState("");

  const lists = useQuery({ queryKey: ["price-lists"], queryFn: getAllPriceLists, staleTime: 60_000 });
  const detail = useQuery({ queryKey: ["price-list", selectedId], queryFn: () => getPriceListById(selectedId), enabled: Boolean(selectedId) });

  return <div className="content">
    <PageTitle title="Price lists" description="Wholesale, dealer and other prices. A price applies from its minimum quantity up, so 10+ cartons can cost less per carton." />
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <div className="two-column">
      <section className="panel stack" aria-label="Price lists">
        <h2>Lists</h2>
        <ul className="role-list">{(lists.data ?? []).map((list) => <li key={list.id}>
          <span><strong>{list.name}</strong></span>
          <button className="text-button" type="button" onClick={() => { setNotice(""); setParams({ id: list.id }); }}>Open {list.name}</button>
        </li>)}</ul>
        {lists.data && !lists.data.length && <p className="muted">No price lists yet.</p>}
        {canManage && <button className="button primary" type="button" onClick={() => { setNotice(""); setParams({ new: "1" }); }}>New price list</button>}
      </section>

      {selectedId && detail.isPending && <section className="panel"><p className="muted">Loading…</p></section>}
      {selectedId && detail.isError && <section className="panel"><ErrorMessage>{detail.error.message}</ErrorMessage></section>}
      {/* Keyed by list, so opening another list starts the form afresh from that list's saved data. */}
      {((creating && !selectedId) || detail.data) && (
        <PriceListEditor key={selectedId || "new"} detail={selectedId ? detail.data ?? null : null} canManage={canManage}
          onSaved={(saved) => { setNotice(`${saved.name} saved.`); setParams({ id: saved.id }); }} />
      )}
    </div>
  </div>;
}

function PriceListEditor({ detail, canManage, onSaved }: { detail: PriceListDetail | null; canManage: boolean; onSaved: (saved: PriceListDetail) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(detail?.name ?? "");
  const [active, setActive] = useState(detail?.active ?? true);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(detail));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";

  function addRow(product: Product, variant: ProductVariant) {
    const base = variant.units.find((unit) => unit.isBase) ?? variant.units[0];
    setRows([...rows, {
      key: crypto.randomUUID(), variantId: variant.id, sku: variant.sku, label: product.name + (variant.variantName ? ` · ${variant.variantName}` : ""),
      unitIds: variant.units.map((unit) => unit.unitId), unitId: base.unitId, minQuantity: "1", price: toPlainRupees(base.salePricePaisa),
    }]);
  }
  const change = (key: string, patch: Partial<Row>) => setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    let input;
    try {
      input = {
        name,
        active,
        items: rows.map((row) => {
          try {
            return { variantId: row.variantId, unitId: row.unitId, minQuantity: row.minQuantity.trim(), pricePaisa: parseRupees(row.price) };
          } catch {
            throw new Error(`${row.sku}: "${row.price}" is not a valid price. Use rupees with up to two decimals, e.g. 1250.50`);
          }
        }),
      };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check the prices");
      return;
    }
    const checked = priceListSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      const row = issue.path[0] === "items" && typeof issue.path[1] === "number" ? rows[issue.path[1]] : undefined;
      setError(`${row ? `${row.sku}: ` : ""}${issue.message}`);
      return;
    }
    setBusy(true);
    try {
      const saved = detail ? await updatePriceList(detail.id, input) : await createPriceList(input);
      await Promise.all(["price-lists", "price-list"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the price list");
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel stack" aria-label="Price list editor">
    <form className="stack" onSubmit={(event) => void save(event)}>
      <h2>{detail ? "Edit price list" : "New price list"}</h2>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} readOnly={!canManage} /></Field>
      {canManage && detail && <label className="checkbox-row"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span><strong>Active</strong></span></label>}
      {canManage && <ProductPicker label="Add a product" isPicked={() => false} onPick={addRow} />}
      <div className="table-scroll"><table>
        <thead><tr><th>Product</th><th>Unit</th><th>From quantity</th><th>Price (PKR)</th><th /></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key}>
          <td><strong>{row.label}</strong><br /><span className="mono">{row.sku}</span></td>
          <td><SelectInput aria-label={`Unit for ${row.sku}`} value={row.unitId} disabled={!canManage} onChange={(event) => change(row.key, { unitId: event.target.value })}>
            {row.unitIds.map((unitId) => <option key={unitId} value={unitId}>{unitName(unitId)}</option>)}
          </SelectInput></td>
          <td><QuantityInput aria-label={`From quantity for ${row.sku}`} value={row.minQuantity} readOnly={!canManage} onChange={(event) => change(row.key, { minQuantity: event.target.value })} /></td>
          <td><MoneyInput aria-label={`Price for ${row.sku}`} value={row.price} readOnly={!canManage} onChange={(event) => change(row.key, { price: event.target.value })} /></td>
          <td className="action-cell">{canManage && <button className="text-button" type="button" onClick={() => setRows(rows.filter((candidate) => candidate.key !== row.key))}>Remove</button>}</td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <p className="muted">No prices yet. Add a product above.</p>}
      {canManage && <div className="button-row"><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save price list"}</button></div>}
    </form>
  </section>;
}
