import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllPurchaseBills } from "../../api/billsApi";
import { ErrorMessage, PageTitle, TextInput } from "../../app/FormElements";
import { dayText } from "./dayText";

const pageSize = 25;

export function PurchaseBillsPage() {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({ queryKey: ["purchase-bills", { search, page }], queryFn: ({ signal }) => getAllPurchaseBills({ q: search, page, pageSize }, signal), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Supplier bills" description="What suppliers have billed for goods you received. A bill is what you owe; it cannot be changed, only put right with a purchase return." />
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search bills" placeholder="Bill number, supplier or their invoice number" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <div className="button-row"><Link className="button primary" to="/purchase-bills/new">Enter a supplier bill</Link></div>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Supplier bills">
        <thead><tr><th>Bill</th><th>Supplier</th><th>Their invoice</th><th>Date</th><th>Due</th><th className="num">Input tax</th><th className="num">Total</th><th className="num">Owing</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/purchase-bills/${row.id}`}>{row.number}</Link></td>
            <td>{row.supplierName}</td><td>{row.supplierInvoiceNo}</td><td>{dayText(row.billDate)}</td><td>{dayText(row.dueDate)}</td>
            <td className="num">{row.taxPaisa ? formatPkr(row.taxPaisa) : ""}</td><td className="num">{formatPkr(row.totalPaisa)}</td>
            <td className="num">{row.outstandingPaisa ? formatPkr(row.outstandingPaisa) : <span className="muted">paid</span>}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={8} className="muted">No bills have been entered yet.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "bill" : "bills"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
