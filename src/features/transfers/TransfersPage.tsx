import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { transferStatusLabels, type TransferStatus } from "../../../shared/schemas/transfers";
import { getAllInTransit, getAllStockTransfers, type TransferFilter } from "../../api/transfersApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText } from "../purchasing/dayText";
import { groupDigits } from "../stock/stockFormat";

const pageSize = 25;

/** Goods moving between locations: what is on its way, and every transfer written. */
export function TransfersPage() {
  const mayManage = useCan("transfers.manage");
  const [status, setStatus] = useState<TransferFilter["status"]>("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const transit = useQuery({ queryKey: ["in-transit"], queryFn: getAllInTransit, staleTime: 15_000 });
  const list = useQuery({
    queryKey: ["stock-transfers", { status, search, page }],
    queryFn: ({ signal }) => getAllStockTransfers({ status, q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const onTheWay = transit.data?.data ?? [];

  return <div className="content">
    <PageTitle title="Stock transfers" description="Move goods between locations. Stock leaves the source when it is sent and enters the destination when it is received; in between it is in transit." />
    {onTheWay.length > 0 && <section className="panel stack" aria-label="In transit">
      <h2>In transit now</h2>
      <div className="table-scroll"><table aria-label="In transit">
        <thead><tr><th>Transfer</th><th>Item</th><th>From</th><th>To</th><th className="num">Quantity</th>{onTheWay.some((row) => row.valuePaisa !== undefined) && <th className="num">Value</th>}</tr></thead>
        <tbody>{onTheWay.map((row) => <tr key={`${row.transferId}-${row.variantId}`}>
          <td><Link className="text-button" to={`/transfers/${row.transferId}`}>{row.number}</Link></td>
          <td>{row.productName} <span className="mono">{row.sku}</span></td><td>{row.fromName}</td><td>{row.toName}</td>
          <td className="num">{groupDigits(row.qtyBase)}</td>
          {row.valuePaisa !== undefined && <td className="num">{formatPkr(row.valuePaisa)}</td>}
        </tr>)}</tbody>
      </table></div>
    </section>}

    <section className="panel stack">
      <div className="form-grid">
        <Field label="Status">
          <SelectInput value={status} onChange={(event) => { setStatus(event.target.value as TransferFilter["status"]); setPage(1); }}>
            <option value="">All</option><option value="open">Not finished</option>
            {(Object.keys(transferStatusLabels) as TransferStatus[]).map((value) => <option key={value} value={value}>{transferStatusLabels[value]}</option>)}
          </SelectInput>
        </Field>
        <Field label="Search"><TextInput aria-label="Search transfers" placeholder="Transfer number or note" value={text} onChange={(event) => setText(event.target.value)} /></Field>
      </div>
      {mayManage && <div className="button-row"><Link className="button primary" to="/transfers/new">New transfer</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Stock transfers">
        <thead><tr><th>Transfer</th><th>From</th><th>To</th><th>Items</th><th>Status</th><th>Written</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/transfers/${row.id}`}>{row.number}</Link></td>
            <td>{row.fromName}</td><td>{row.toName}</td><td>{row.items}</td><td>{transferStatusLabels[row.status]}</td><td>{dayText(row.createdAt.slice(0, 10))}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">No transfers here.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "transfer" : "transfers"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
