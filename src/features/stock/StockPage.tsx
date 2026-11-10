import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllUnits } from "../../api/catalogueApi";
import { getStockLevels } from "../../api/inventoryApi";
import { getAllLocations } from "../../api/orgApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { describeStock, groupDigits } from "./stockFormat";
import { StockTabs } from "./StockTabs";

const pageSize = 25;
const referenceStaleTime = 5 * 60_000;

export function StockPage() {
  const canAdjust = useCan("inventory.adjust");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [locationId, setLocationId] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server (300 ms, technical-plan 5.7).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: referenceStaleTime });
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: referenceStaleTime });
  const levels = useQuery({
    queryKey: ["stock", { q: debouncedSearch, locationId, lowOnly, page }],
    queryFn: ({ signal }) => getStockLevels({ q: debouncedSearch, locationId, low: lowOnly, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });

  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";
  const rows = levels.data?.data ?? [];
  const total = levels.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showsValue = rows.some((row) => row.valuePaisa !== undefined);

  return <div className="content">
    <PageTitle title="Stock" description="What is on hand now, in the unit it is kept in and in larger units. Stock changes only through documents, never by editing a number." />
    <StockTabs />
    {levels.isError && <ErrorMessage>{levels.error.message}</ErrorMessage>}
    <section className="panel stack">
      <div className="form-actions">
        <label className="field"><span>Search</span><TextInput type="search" placeholder="Name, SKU or barcode" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label className="field"><span>Location</span>
          <SelectInput value={locationId} onChange={(event) => { setLocationId(event.target.value); setPage(1); }}>
            <option value="">All locations</option>
            {(locations.data ?? []).filter((location) => location.active).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </SelectInput>
        </label>
        <label className="checkbox-row"><input type="checkbox" checked={lowOnly} onChange={(event) => { setLowOnly(event.target.checked); setPage(1); }} /><span><strong>Low stock only</strong><small>At or below the reorder level</small></span></label>
      </div>
      {canAdjust && <div className="button-row"><Link className="button primary" to="/stock/adjustments/new">Adjust stock</Link></div>}
      <div className="table-scroll"><table>
        <thead><tr><th>Product</th><th>SKU</th><th>On hand</th><th>Available</th><th>Reorder at</th>{showsValue && <th>Value</th>}<th /></tr></thead>
        <tbody>{rows.map((row) => {
          const stock = describeStock(row.onHand, row.units, unitName);
          return <tr key={row.variantId}>
            <td><strong>{row.productName}</strong>{row.variantName && <small className="muted"> · {row.variantName}</small>}</td>
            <td className="mono">{row.sku}</td>
            <td>{stock.main}{stock.detail && <small className="muted"> ({stock.detail})</small>}{row.low && <> <span className="status">Low</span></>}</td>
            <td>{row.available}{row.inTransit !== "0" && <small className="muted block" data-testid={`in-transit-${row.sku}`}>{groupDigits(row.inTransit)} in transit</small>}</td>
            <td>{row.reorderLevel === "0" ? "—" : row.reorderLevel}</td>
            {showsValue && <td>{row.valuePaisa === undefined ? "" : formatPkr(row.valuePaisa)}</td>}
            <td className="action-cell"><Link className="text-button" to={`/stock/ledger?variantId=${row.variantId}`}>Movements</Link></td>
          </tr>;
        })}</tbody>
      </table></div>
      {levels.isPending && <p className="muted">Loading stock…</p>}
      {!levels.isPending && !rows.length && <p className="muted">{debouncedSearch || lowOnly ? "Nothing matches." : "No stocked products yet."}</p>}
      <div className="button-row">
        <button className="button secondary" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted" role="status">Page {page} of {pageCount} · {total} SKU{total === 1 ? "" : "s"}</span>
        <button className="button secondary" type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
