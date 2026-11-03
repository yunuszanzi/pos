import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { parseRupees } from "../../../shared/money";
import { stockAdjustmentSchema, adjustmentReasons } from "../../../shared/schemas/inventory";
import { getAllUnits } from "../../api/catalogueApi";
import { createStockAdjustment } from "../../api/inventoryApi";
import { getAllLocations } from "../../api/orgApi";
import { getAllProducts, type Product, type ProductVariant } from "../../api/productsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { adjustmentReasonLabels } from "./stockFormat";
import { StockTabs } from "./StockTabs";

type Line = {
  variant: ProductVariant;
  productName: string;
  unitId: string;
  direction: "add" | "remove";
  quantity: string;
  cost: string;
};

export function NewAdjustmentPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canSeeCost = useCan("products.cost.view");
  const [locationId, setLocationId] = useState("");
  const [reason, setReason] = useState<(typeof adjustmentReasons)[number]>("damage");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for this form: a double click or a retry after a dropped connection adjusts stock once.
  const idempotencyKey = useRef(crypto.randomUUID());

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const results = useQuery({
    queryKey: ["products", { picker: debouncedSearch }],
    queryFn: ({ signal }) => getAllProducts({ q: debouncedSearch, pageSize: 8, active: "true" }, signal),
    enabled: debouncedSearch.length > 0,
  });

  const activeLocations = (locations.data ?? []).filter((location) => location.active);
  // Until the user picks one, use the first location.
  const chosenLocationId = locationId || activeLocations[0]?.id || "";

  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";
  const pickable = (results.data?.data ?? []).filter((product: Product) => product.productType === "stocked")
    .flatMap((product) => product.variants.filter((variant) => variant.active).map((variant) => ({ product, variant })));

  function addLine(product: Product, variant: ProductVariant) {
    if (lines.some((line) => line.variant.id === variant.id)) return;
    const base = variant.units.find((unit) => unit.isBase) ?? variant.units[0];
    setLines([...lines, { variant, productName: product.name, unitId: base.unitId, direction: "remove", quantity: "", cost: "" }]);
    setSearch("");
  }

  const change = (index: number, patch: Partial<Line>) => setLines(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    let input;
    try {
      input = {
        locationId: chosenLocationId,
        reason,
        note,
        lines: lines.map((line) => ({
          variantId: line.variant.id,
          unitId: line.unitId,
          quantity: `${line.direction === "remove" ? "-" : ""}${line.quantity.trim()}`,
          ...(canSeeCost && line.direction === "add" && line.cost.trim() ? { unitCostPaisa: parseRupees(line.cost) } : {}),
        })),
      };
    } catch {
      setError("A cost is not a valid amount. Use rupees with up to two decimals, e.g. 1250.50");
      return;
    }
    const checked = stockAdjustmentSchema.safeParse(input);
    if (!checked.success) {
      const [issue] = checked.error.issues;
      const line = issue.path[0] === "lines" && typeof issue.path[1] === "number" ? lines[issue.path[1]] : undefined;
      setError(`${line ? `${line.variant.sku}: ` : ""}${issue.message}`);
      return;
    }
    setBusy(true);
    try {
      const saved = await createStockAdjustment(input, idempotencyKey.current);
      await Promise.all(["stock", "adjustments", "ledger"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      navigate("/stock/adjustments", { state: { notice: saved.status === "pending" ? "Adjustment sent for approval. Stock changes once it is approved." : "Adjustment posted to stock." } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the adjustment");
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="New stock adjustment" description="Add the products affected, choose whether stock goes up or down, and say why. Large adjustments are sent for approval." />
    <StockTabs />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <Field label="Location"><SelectInput value={chosenLocationId} onChange={(event) => setLocationId(event.target.value)} required>{activeLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</SelectInput></Field>
          <Field label="Reason"><SelectInput value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>{adjustmentReasons.map((value) => <option key={value} value={value}>{adjustmentReasonLabels[value]}</option>)}</SelectInput></Field>
          <Field label="Note"><TextInput value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="What happened?" /></Field>
        </div>
      </section>

      <section className="panel stack">
        <h2>Products</h2>
        <Field label="Find a product to add"><TextInput type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, SKU or barcode" /></Field>
        {debouncedSearch && results.isPending && <p className="muted">Searching…</p>}
        {debouncedSearch && results.data && !pickable.length && <p className="muted">No stocked product matches.</p>}
        {pickable.length > 0 && <ul className="role-list" aria-label="Search results">{pickable.map(({ product, variant }) => <li key={variant.id}>
          <span><strong>{product.name}</strong><small>{variant.sku}{variant.variantName ? ` · ${variant.variantName}` : ""}</small></span>
          <button className="text-button" type="button" disabled={lines.some((line) => line.variant.id === variant.id)} onClick={() => addLine(product, variant)}>Add {variant.sku}</button>
        </li>)}</ul>}

        {lines.map((line, index) => <div className="form-grid" key={line.variant.id} role="group" aria-label={`Line ${line.variant.sku}`}>
          <div><strong>{line.productName}</strong><br /><span className="mono">{line.variant.sku}</span></div>
          <Field label="Stock goes"><SelectInput value={line.direction} onChange={(event) => change(index, { direction: event.target.value as Line["direction"] })}><option value="remove">Down (remove)</option><option value="add">Up (add)</option></SelectInput></Field>
          <Field label="Quantity"><TextInput value={line.quantity} onChange={(event) => change(index, { quantity: event.target.value })} inputMode="decimal" placeholder="0" required /></Field>
          <Field label="Unit"><SelectInput value={line.unitId} onChange={(event) => change(index, { unitId: event.target.value })}>{line.variant.units.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unitName(unit.unitId)}</option>)}</SelectInput></Field>
          {canSeeCost && line.direction === "add" && <Field label="Cost per unit (PKR, optional)"><TextInput value={line.cost} onChange={(event) => change(index, { cost: event.target.value })} inputMode="decimal" placeholder="Uses the SKU cost" /></Field>}
          <button className="text-button" type="button" onClick={() => setLines(lines.filter((_, position) => position !== index))}>Remove line</button>
        </div>)}
        {!lines.length && <p className="muted">No products added yet.</p>}
      </section>

      <div className="button-row">
        <button className="button primary" disabled={busy || !lines.length}>{busy ? "Saving…" : "Save adjustment"}</button>
        <Link className="button secondary" to="/stock/adjustments">Cancel</Link>
      </div>
    </form>
  </div>;
}
