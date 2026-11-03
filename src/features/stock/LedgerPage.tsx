import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getStockLedger } from "../../api/inventoryApi";
import { getAllLocations } from "../../api/orgApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { documentLabels, groupDigits } from "./stockFormat";
import { StockTabs } from "./StockTabs";

const pageSize = 25;

export function LedgerPage() {
  const [params] = useSearchParams();
  const variantId = params.get("variantId") ?? "";
  const [locationId, setLocationId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000 });
  const ledger = useQuery({
    queryKey: ["ledger", { variantId, locationId, from, to, page }],
    queryFn: () => getStockLedger({ variantId, locationId, from, to, page, pageSize }),
    enabled: Boolean(variantId),
    placeholderData: keepPreviousData,
  });

  const total = ledger.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showsCost = ledger.data?.data.some((entry) => entry.unitCostPaisa !== undefined) ?? false;
  const title = ledger.data ? `Movements · ${ledger.data.variant.productName}` : "Movements";

  return <div className="content">
    <PageTitle title={title} description={ledger.data ? `SKU ${ledger.data.variant.sku}. Every entry is permanent; the balance is the running total after it.` : "Every stock movement of one product."} />
    <StockTabs />
    {!variantId && <ErrorMessage>Open a product's movements from the stock list.</ErrorMessage>}
    {ledger.isError && <ErrorMessage>{ledger.error.message}</ErrorMessage>}
    <section className="panel stack">
      <div className="form-actions">
        <label className="field"><span>Location</span>
          <SelectInput value={locationId} onChange={(event) => { setLocationId(event.target.value); setPage(1); }}>
            <option value="">All locations</option>
            {(locations.data ?? []).map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </SelectInput>
        </label>
        <label className="field"><span>From</span><TextInput type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
        <label className="field"><span>To</span><TextInput type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
      </div>
      <div className="table-scroll"><table>
        <thead><tr><th>When</th><th>Location</th><th>Document</th><th>Quantity</th><th>Balance</th>{showsCost && <th>Cost</th>}<th>By</th></tr></thead>
        <tbody>{(ledger.data?.data ?? []).map((entry) => <tr key={entry.id}>
          <td>{new Date(entry.createdAt).toLocaleString()}</td>
          <td>{entry.locationName}</td>
          <td>{entry.docType === "stock_adjustment"
            ? <Link className="text-button" to={`/stock/adjustments?open=${entry.docId}`}>{documentLabels[entry.docType]}</Link>
            : documentLabels[entry.docType] ?? entry.docType}</td>
          <td><strong>{entry.quantity.startsWith("-") ? "" : "+"}{groupDigits(entry.quantity)}</strong></td>
          <td>{groupDigits(entry.balanceAfter)}</td>
          {showsCost && <td>{entry.unitCostPaisa === undefined ? "" : formatPkr(entry.unitCostPaisa)}</td>}
          <td>{entry.createdByName ?? "—"}</td>
        </tr>)}</tbody>
      </table></div>
      {ledger.isPending && variantId && <p className="muted">Loading movements…</p>}
      {ledger.data && !ledger.data.data.length && <p className="muted">No movements match.</p>}
      <div className="button-row">
        <button className="button secondary" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted" role="status">Page {page} of {pageCount} · {total} movement{total === 1 ? "" : "s"}</span>
        <button className="button secondary" type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
        <Link className="button secondary" to="/stock">Back to stock</Link>
      </div>
    </section>
  </div>;
}
