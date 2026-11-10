import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllPurchaseReturns } from "../../api/purchasingApi";
import { ErrorMessage, PageTitle, TextInput } from "../../app/FormElements";
import { momentDayText } from "./dayText";

const pageSize = 25;

/** Goods sent back to suppliers. A return is started from the goods receipt the goods came on. */
export function PurchaseReturnsPage() {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({ queryKey: ["purchase-returns", { search, page }], queryFn: ({ signal }) => getAllPurchaseReturns({ q: search, page, pageSize }, signal), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Purchase returns" description="Goods sent back to suppliers, with the credit they gave. Start one from the goods receipt the goods came on." />
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search returns" placeholder="Return number, supplier or receipt number" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <div className="button-row"><Link className="button secondary" to="/goods-receipts">Find a goods receipt</Link></div>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Purchase returns">
        <thead><tr><th>Return</th><th>Date</th><th>Supplier</th><th>Goods receipt</th><th>Reason</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/purchase-returns/${row.id}`}>{row.number}</Link></td>
            <td>{momentDayText(row.postedAt)}</td><td>{row.supplierName}</td><td>{row.receiptNumber}</td><td>{row.reason}</td><td className="num">{formatPkr(row.totalPaisa)}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">No goods have been sent back yet.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "return" : "returns"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
