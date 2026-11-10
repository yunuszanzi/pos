import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { challanStatuses, challanStatusLabels, type ChallanStatus } from "../../../shared/schemas/deliveryChallans";
import { getAllDeliveryChallans } from "../../api/deliveryApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { momentDayText } from "../purchasing/dayText";

const pageSize = 25;
type View = ChallanStatus | "active" | "all";

export function DeliveryChallansPage() {
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
    queryKey: ["delivery-challans", { view, search, page }],
    queryFn: ({ signal }) => getAllDeliveryChallans({ status: view === "all" ? "" : view, q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Delivery challans" description="What goes out on each trip. A challan is written from a sales order; the stock leaves when it is dispatched." />
    <section className="panel stack">
      <div className="form-grid">
        <SelectInput aria-label="Show" value={view} onChange={(event) => { setView(event.target.value as View); setPage(1); }}>
          <option value="active">Waiting or on the road</option>
          {challanStatuses.map((status) => <option key={status} value={status}>{challanStatusLabels[status]}</option>)}
          <option value="all">All</option>
        </SelectInput>
        <TextInput aria-label="Search challans" placeholder="Challan, order, customer, driver or vehicle" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <p className="muted">To write a challan, open a sales order and choose "Write a delivery challan".</p>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Delivery challans">
        <thead><tr><th>Challan</th><th>Order</th><th>Customer</th><th>Driver</th><th>Vehicle</th><th>Route</th><th>Dispatched</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/delivery-challans/${row.id}`}>{row.number}</Link></td>
            <td>{row.orderNumber}</td><td>{row.customerName}</td><td>{row.driverName}</td><td>{row.vehicleNo}</td><td>{row.route}</td>
            <td>{momentDayText(row.dispatchedAt)}</td><td>{challanStatusLabels[row.status]}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={8} className="muted">{view === "active" ? "Nothing is waiting to go or on the road." : "No challans here."}</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "challan" : "challans"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
