import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllSalesInvoices, type InvoiceFilter } from "../../api/salesInvoicesApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText, momentDayText } from "../purchasing/dayText";

const pageSize = 25;
type View = NonNullable<InvoiceFilter["status"]> | "all";

export function InvoicesPage() {
  const mayCreate = useCan("invoices.create");
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
    queryKey: ["sales-invoices", { view, search, page }],
    queryFn: ({ signal }) => getAllSalesInvoices({ status: view === "all" ? "" : view, q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Invoices" description="Invoices written at the desk for customers on credit. The customer pays later; receive the money from their khata and it settles the oldest invoice first." />
    <section className="panel stack">
      <div className="form-grid">
        <SelectInput aria-label="Show" value={view} onChange={(event) => { setView(event.target.value as View); setPage(1); }}>
          <option value="open">Still owing</option>
          <option value="overdue">Overdue</option>
          <option value="paid">Paid</option>
          <option value="all">All</option>
        </SelectInput>
        <TextInput aria-label="Search invoices" placeholder="Invoice number, customer or their PO" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {mayCreate && <div className="button-row"><Link className="button primary" to="/invoices/new">New invoice</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Invoices">
        <thead><tr><th>Invoice</th><th>Customer</th><th>Order</th><th>Date</th><th>Due</th><th className="num">Total</th><th className="num">Owing</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/invoices/${row.id}`}>{row.number}</Link></td>
            <td>{row.customerName}</td><td>{row.orderNumber ?? ""}</td><td>{momentDayText(row.postedAt)}</td>
            <td>{dayText(row.dueDate)}{row.overdue && <small className="block muted">Overdue</small>}</td>
            <td className="num">{formatPkr(row.totalPaisa)}</td><td className="num">{formatPkr(row.outstandingPaisa)}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={7} className="muted">{view === "open" ? "No invoice is waiting to be paid." : "No invoices here."}</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "invoice" : "invoices"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
