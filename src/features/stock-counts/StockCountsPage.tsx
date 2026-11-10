import { useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { stockCountStatusLabels } from "../../../shared/schemas/stockCounts";
import { getAllLocations } from "../../api/orgApi";
import type { Product, ProductVariant } from "../../api/productsApi";
import { getAllStockCounts, startStockCount } from "../../api/stockCountsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText } from "../purchasing/dayText";
import { ProductPicker } from "../products/ProductPicker";

/** Physical counts: the ones in progress and past, and the form that starts a new one. */
export function StockCountsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayCount = useCan("inventory.count");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [locationId, setLocationId] = useState("");
  const [scope, setScope] = useState<"full" | "partial">("full");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Array<{ variant: ProductVariant; productName: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for this form: a double click or a retry after a dropped connection starts one count.
  const idempotencyKey = useRef(crypto.randomUUID());

  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const active = (locations.data ?? []).filter((location) => location.active).sort((a, b) => a.name.localeCompare(b.name));
  const chosen = locationId || active[0]?.id || "";
  const list = useQuery({ queryKey: ["stock-counts", { status, page }], queryFn: ({ signal }) => getAllStockCounts(status, page, signal), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 25));

  function pick(product: Product, variant: ProductVariant) {
    if (!picked.some((entry) => entry.variant.id === variant.id)) setPicked([...picked, { variant, productName: product.name }]);
  }

  async function start() {
    setError(""); setBusy(true);
    try {
      const counted = await startStockCount({ locationId: chosen, scope, note, variantIds: scope === "partial" ? picked.map((entry) => entry.variant.id) : [] }, idempotencyKey.current);
      await queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
      navigate(`/stock-counts/${counted.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the count");
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="Stock counts" description="Count what is really on the shelf. The books' figure is frozen when a count starts; differences are reviewed and only then change stock." />
    {mayCount && <section className="panel stack" aria-label="Start a count">
      <h2>Start a count</h2>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="form-grid">
        <Field label="Location"><SelectInput value={chosen} onChange={(event) => setLocationId(event.target.value)}>{active.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</SelectInput></Field>
        <Field label="What to count"><SelectInput value={scope} onChange={(event) => setScope(event.target.value as "full" | "partial")}>
          <option value="full">Everything in the location (full count)</option><option value="partial">Chosen items only (cycle count)</option>
        </SelectInput></Field>
        <Field label="Note"><TextInput value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Optional" /></Field>
      </div>
      {scope === "partial" && <>
        <ProductPicker stockedOnly isPicked={(variantId) => picked.some((entry) => entry.variant.id === variantId)} onPick={pick} />
        <ul className="role-list" aria-label="Items to count">{picked.map((entry) => <li key={entry.variant.id}>
          <span><strong>{entry.productName}</strong><small>{entry.variant.sku}</small></span>
          <button className="text-button" type="button" onClick={() => setPicked(picked.filter((other) => other !== entry))}>Remove</button>
        </li>)}</ul>
      </>}
      <div className="button-row"><button className="button primary" disabled={busy || !chosen || (scope === "partial" && !picked.length)} onClick={() => void start()}>{busy ? "Starting…" : "Start counting"}</button></div>
    </section>}

    <section className="panel stack">
      <Field label="Show">
        <SelectInput value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">All counts</option><option value="open">Not finished</option>
          {Object.entries(stockCountStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectInput>
      </Field>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Stock counts">
        <thead><tr><th>Count</th><th>Location</th><th>Kind</th><th>Counted</th><th>Status</th><th>Started</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/stock-counts/${row.id}`}>{row.number}</Link></td>
            <td>{row.locationName}</td><td>{row.scope === "full" ? "Full" : "Chosen items"}</td><td>{row.counted} of {row.items}</td>
            <td>{stockCountStatusLabels[row.status]}</td><td>{dayText(row.startedAt.slice(0, 10))}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">No counts yet.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "count" : "counts"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
