import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllGoodsReceipts } from "../../api/purchasingApi";
import { ErrorMessage, PageTitle, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { momentDayText } from "./dayText";

const pageSize = 25;

export function GoodsReceiptsPage() {
  const mayReceive = useCan("purchasing.receive");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({ queryKey: ["goods-receipts", { search, page }], queryFn: ({ signal }) => getAllGoodsReceipts({ q: search, page, pageSize }, signal), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Goods receipts" description="Every delivery that was booked into stock, newest first. A receipt cannot be changed; a mistake is put right with a purchase return." />
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search receipts" placeholder="Receipt number, supplier or challan number" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {mayReceive && <div className="button-row"><Link className="button primary" to="/goods-receipts/new">Receive goods without an order</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Goods receipts">
        <thead><tr><th>Receipt</th><th>Date</th><th>Supplier</th><th>Order</th><th>Supplier's reference</th><th className="num">Value</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/goods-receipts/${row.id}`}>{row.number}</Link></td>
            <td>{momentDayText(row.receivedAt)}</td><td>{row.supplierName}</td><td>{row.orderNumber ?? <span className="muted">no order</span>}</td><td>{row.supplierRef}</td>
            <td className="num">{row.totalPaisa === undefined ? "" : formatPkr(row.totalPaisa)}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">No goods have been received yet.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "receipt" : "receipts"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
