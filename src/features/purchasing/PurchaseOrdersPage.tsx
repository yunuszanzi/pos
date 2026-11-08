import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { poStatusLabels, poStatuses, type PoStatus } from "../../../shared/purchasing";
import { getAllPurchaseOrders } from "../../api/purchasingApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText } from "./dayText";

const pageSize = 25;
type View = PoStatus | "open" | "all";

export function PurchaseOrdersPage() {
  const mayOrder = useCan("purchasing.order");
  const mayReceive = useCan("purchasing.receive");
  const [view, setView] = useState<View>("open");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({
    queryKey: ["purchase-orders", { view, search, page }],
    queryFn: ({ signal }) => getAllPurchaseOrders({ status: view === "all" ? "" : view, q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Purchase orders" description="What you have asked suppliers for. An order is sent from its page, and goods are received against it, in parts if they come in parts." />
    <section className="panel stack">
      <div className="form-grid">
        <SelectInput aria-label="Show" value={view} onChange={(event) => { setView(event.target.value as View); setPage(1); }}>
          <option value="open">Waiting for goods</option>
          {poStatuses.map((status) => <option key={status} value={status}>{poStatusLabels[status]}</option>)}
          <option value="all">All</option>
        </SelectInput>
        <TextInput aria-label="Search orders" placeholder="Order number or supplier" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <div className="button-row">
        {mayOrder && <Link className="button primary" to="/purchase-orders/new">New purchase order</Link>}
        {mayReceive && <Link className="button secondary" to="/goods-receipts/new">Receive goods without an order</Link>}
      </div>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Purchase orders">
        <thead><tr><th>Order</th><th>Supplier</th><th>Date</th><th>Expected</th><th>Status</th><th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/purchase-orders/${row.id}`}>{row.number}</Link></td>
            <td>{row.supplierName}</td><td>{dayText(row.orderDate)}</td><td>{dayText(row.expectedDate)}</td>
            <td>{poStatusLabels[row.status]}</td>
            <td className="num">{row.totalPaisa === undefined ? "" : formatPkr(row.totalPaisa)}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">{view === "open" ? "Nothing is waiting for goods." : "No orders here."}</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "order" : "orders"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
