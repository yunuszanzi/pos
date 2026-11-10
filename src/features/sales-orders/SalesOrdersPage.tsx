import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { salesOrderStatuses, salesOrderStatusLabels, type SalesOrderStatus } from "../../../shared/schemas/salesOrders";
import { getAllSalesOrders } from "../../api/salesOrdersApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText } from "../purchasing/dayText";

const pageSize = 25;
type View = SalesOrderStatus | "active" | "all";

export function SalesOrdersPage() {
  const mayManage = useCan("sales_orders.manage");
  const [view, setView] = useState<View>("active");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({
    queryKey: ["sales-orders", { view, search, page }],
    queryFn: ({ signal }) => getAllSalesOrders({ status: view === "all" ? "" : view, q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Sales orders" description="What customers have ordered at agreed prices. An open order holds its stock, so it cannot be sold to anyone else; the stock leaves when the goods are dispatched." />
    <section className="panel stack">
      <div className="form-grid">
        <SelectInput aria-label="Show" value={view} onChange={(event) => { setView(event.target.value as View); setPage(1); }}>
          <option value="active">Not finished</option>
          {salesOrderStatuses.map((status) => <option key={status} value={status}>{salesOrderStatusLabels[status]}</option>)}
          <option value="all">All</option>
        </SelectInput>
        <TextInput aria-label="Search orders" placeholder="Order number, customer or their PO" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {mayManage && <div className="button-row"><Link className="button primary" to="/sales-orders/new">New sales order</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Sales orders">
        <thead><tr><th>Order</th><th>Customer</th><th>Their PO</th><th>Date</th><th>Deliver by</th><th>Status</th><th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/sales-orders/${row.id}`}>{row.number}</Link></td>
            <td>{row.customerName}</td><td>{row.customerPo}</td><td>{dayText(row.orderDate)}</td><td>{dayText(row.deliveryDate)}</td>
            <td>{salesOrderStatusLabels[row.status]}</td><td className="num">{formatPkr(row.totalPaisa)}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={7} className="muted">{view === "active" ? "No order is waiting to be delivered." : "No orders here."}</td></tr>}
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
