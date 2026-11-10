import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { stockTransferSchema } from "../../../shared/schemas/transfers";
import { getAllUnits } from "../../api/catalogueApi";
import { getAllLocations } from "../../api/orgApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { postStockTransfer } from "../../api/transfersApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";
import { ProductPicker } from "../products/ProductPicker";

type Line = { variant: ProductVariant; productName: string; unitId: string; quantity: string };

/** Write a transfer: where from, where to, and what. Nothing moves until it is sent. */
export function TransferFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for this form: a double click or a retry after a dropped connection writes it once.
  const idempotencyKey = useRef(crypto.randomUUID());

  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const active = (locations.data ?? []).filter((location) => location.active);
  const from = fromId || active[0]?.id || "";
  const to = toId || active.find((location) => location.id !== from)?.id || "";
  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";

  function addLine(product: Product, variant: ProductVariant) {
    if (lines.some((line) => line.variant.id === variant.id)) return;
    const base = variant.units.find((unit) => unit.isBase) ?? variant.units[0];
    setLines([...lines, { variant, productName: product.name, unitId: base.unitId, quantity: "" }]);
  }
  const change = (index: number, patch: Partial<Line>) => setLines(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const input = { fromLocationId: from, toLocationId: to, note, lines: lines.map((line) => ({ variantId: line.variant.id, unitId: line.unitId, quantity: line.quantity.trim() })) };
    const checked = stockTransferSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      const line = issue.path[0] === "lines" && typeof issue.path[1] === "number" ? lines[issue.path[1]] : undefined;
      setError(`${line ? `${line.variant.sku}: ` : ""}${issue.message}`);
      return;
    }
    setBusy(true);
    try {
      const saved = await postStockTransfer(input, idempotencyKey.current);
      await Promise.all(["stock-transfers", "in-transit"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      navigate(`/transfers/${saved.transfer.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the transfer");
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="New stock transfer" description="Choose where the goods come from and where they go, and add what is being moved. Nothing moves until the transfer is sent." />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <Field label="From"><SelectInput value={from} onChange={(event) => setFromId(event.target.value)} required>{active.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</SelectInput></Field>
          <Field label="To"><SelectInput value={to} onChange={(event) => setToId(event.target.value)} required>{active.filter((location) => location.id !== from).map((location) => <option key={location.id} value={location.id}>{location.name}{location.type === "damaged" ? " (damaged goods)" : ""}</option>)}</SelectInput></Field>
          <Field label="Note"><TextInput value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} placeholder="Optional" /></Field>
        </div>
      </section>
      <section className="panel stack">
        <h2>Items</h2>
        <ProductPicker stockedOnly isPicked={(variantId) => lines.some((line) => line.variant.id === variantId)} onPick={addLine} />
        {lines.map((line, index) => <div className="form-grid" key={line.variant.id} role="group" aria-label={`Line ${line.variant.sku}`}>
          <div><strong>{line.productName}</strong><br /><span className="mono">{line.variant.sku}</span></div>
          <Field label="Quantity"><QuantityInput value={line.quantity} onChange={(event) => change(index, { quantity: event.target.value })} placeholder="0" required /></Field>
          <Field label="Unit"><SelectInput value={line.unitId} onChange={(event) => change(index, { unitId: event.target.value })}>{line.variant.units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unitName(unit.unitId)}</option>)}</SelectInput></Field>
          <button className="text-button" type="button" onClick={() => setLines(lines.filter((_, position) => position !== index))}>Remove line</button>
        </div>)}
        {!lines.length && <p className="muted">No items added yet.</p>}
      </section>
      <div className="button-row">
        <button className="button primary" disabled={busy || !lines.length || !to}>{busy ? "Saving…" : "Save transfer"}</button>
        <Link className="button secondary" to="/transfers">Cancel</Link>
      </div>
    </form>
  </div>;
}
