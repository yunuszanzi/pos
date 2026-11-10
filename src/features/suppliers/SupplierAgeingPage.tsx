import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ageingBands } from "../../../shared/khata";
import { formatPkr } from "../../../shared/money";
import { getSupplierAgeing } from "../../api/suppliersApi";
import { ErrorMessage, PageTitle, TextInput } from "../../app/FormElements";

const pageSize = 25;
const money = (paisa: number) => (paisa ? formatPkr(paisa) : "");

/** What the shop owes each supplier, by how old the debt is. A payment is counted against the oldest debt first. */
export function SupplierAgeingPage() {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const report = useQuery({
    queryKey: ["supplier-ageing", { search, overdueOnly, page }],
    queryFn: ({ signal }) => getSupplierAgeing({ q: search, overdue: overdueOnly, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = report.data?.data ?? [];
  const total = report.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const totals = report.data?.totals;

  return <div className="content">
    <PageTitle title="Payables ageing" description="What you owe suppliers, by how old the debt is. A payment is counted against the oldest debt first." />
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search suppliers" placeholder="Name or phone" value={text} onChange={(event) => setText(event.target.value)} />
        <label className="check"><input type="checkbox" checked={overdueOnly} onChange={(event) => { setOverdueOnly(event.target.checked); setPage(1); }} /> Overdue only</label>
      </div>
      {report.isError && <ErrorMessage>{report.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Payables ageing">
        <thead><tr><th>Supplier</th>{ageingBands.map((band) => <th key={band} className="num">{band} days</th>)}<th className="num">We owe</th><th /></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.supplierId}>
            <td><strong>{row.name}</strong>{row.overdue && <span className="status">Overdue</span>}</td>
            {row.bandsPaisa.map((value, band) => <td key={band} className="num">{money(value)}</td>)}
            <td className="num"><strong>{formatPkr(row.owedPaisa)}</strong></td>
            <td className="action-cell"><Link className="text-button" to={`/suppliers/${row.supplierId}/ledger`}>Ledger</Link></td>
          </tr>)}
          {report.isSuccess && rows.length === 0 && <tr><td colSpan={7} className="muted">{overdueOnly ? "Nothing is past its payment terms." : "You owe nothing."}</td></tr>}
        </tbody>
        {totals && total > 0 && <tfoot><tr>
          <th>Total · {total} {total === 1 ? "supplier" : "suppliers"}</th>
          {totals.bandsPaisa.map((value, band) => <th key={band} className="num">{money(value)}</th>)}
          <th className="num" data-testid="payables-total">{formatPkr(totals.owedPaisa)}</th><th />
        </tr></tfoot>}
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
