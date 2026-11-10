import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { quotationStatusLabels } from "../../../shared/quotations";
import type { QuotationStatus } from "../../../shared/schemas/quotations";
import { getAllQuotations } from "../../api/quotationsApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText } from "../purchasing/dayText";

const pageSize = 25;
type View = QuotationStatus | "open" | "all";

export function QuotationsPage() {
  const mayManage = useCan("quotations.manage");
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
    queryKey: ["quotations", { view, search, page }],
    queryFn: ({ signal }) => getAllQuotations({ status: view === "all" ? "" : view, q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title="Quotations" description="Offers you have given. A quotation does not touch stock or accounts. Once sent it is fixed; to change it, write a new revision." />
    <section className="panel stack">
      <div className="form-grid">
        <SelectInput aria-label="Show" value={view} onChange={(event) => { setView(event.target.value as View); setPage(1); }}>
          <option value="open">Waiting for an answer</option>
          {(Object.keys(quotationStatusLabels) as QuotationStatus[]).filter((status) => status !== "revised").map((status) => <option key={status} value={status}>{quotationStatusLabels[status]}</option>)}
          <option value="all">All (latest revisions)</option>
        </SelectInput>
        <TextInput aria-label="Search quotations" placeholder="Quotation number or customer" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {mayManage && <div className="button-row"><Link className="button primary" to="/quotations/new">New quotation</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Quotations">
        <thead><tr><th>Quotation</th><th>For</th><th>Date</th><th>Valid until</th><th>Status</th><th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/quotations/${row.id}`}>{row.number}{row.revisionNo > 1 ? ` Rev ${row.revisionNo}` : ""}</Link></td>
            <td>{row.customerName}</td><td>{dayText(row.quoteDate)}</td><td>{dayText(row.validUntil)}</td>
            <td>{quotationStatusLabels[row.status]}</td><td className="num">{formatPkr(row.totalPaisa)}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">{view === "open" ? "No quotation is waiting for an answer." : "No quotations here."}</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "quotation" : "quotations"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
