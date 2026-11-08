import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { formatDocumentDate } from "../../../shared/receipt";
import { getAppBootstrapData } from "../../api/posApi";
import { getSupplierLedger } from "../../api/suppliersApi";
import { ErrorMessage, PageTitle } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { useTerminalStore } from "../../app/terminalStore";

const owedText = (paisa: number) => (paisa < 0 ? `${formatPkr(-paisa)} Dr` : formatPkr(paisa));

/** What the shop owes a supplier and how it came about: bills and opening balances add to it, payments and returns take it down. */
export function SupplierLedgerPage() {
  const { id = "" } = useParams();
  const maySell = useCan("sales.create");
  const terminalId = useTerminalStore((state) => state.terminalId);
  const [page, setPage] = useState(1);
  const ledger = useQuery({ queryKey: ["supplier-ledger", id, page], queryFn: ({ signal }) => getSupplierLedger(id, page, signal), placeholderData: keepPreviousData });
  // The date style comes from the same bootstrap call the till makes, shared by its cache key.
  const setup = useQuery({ queryKey: ["pos-bootstrap", terminalId], queryFn: getAppBootstrapData, staleTime: Infinity, enabled: maySell });

  if (ledger.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (ledger.isError) return <div className="content"><ErrorMessage>{ledger.error.message}</ErrorMessage></div>;
  const { supplier, entries, total, pageSize } = ledger.data;
  const settings = setup.data?.settings;
  const dateOf = (iso: string) => formatDocumentDate(iso, settings?.dateFormat ?? "dd/MM/yyyy", settings?.timezone ?? "Asia/Karachi").split(" ")[0];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return <div className="content">
    <PageTitle title={`${supplier.name} — ledger`} description="Bills add to what you owe; payments and returns take it down." />
    <p><Link className="text-button" to="/suppliers">← Back to suppliers</Link></p>
    <section className="panel stack">
      <dl className="totals">
        <div className="grand"><dt>{supplier.balancePaisa < 0 ? "Credit with them" : "We owe"}</dt><dd data-testid="supplier-balance">{formatPkr(Math.abs(supplier.balancePaisa))}</dd></div>
        {supplier.termsDays > 0 && <div><dt>Payment terms</dt><dd>{supplier.termsDays} days</dd></div>}
      </dl>
    </section>
    <section className="panel stack">
      <h2>Ledger</h2>
      <div className="table-scroll"><table aria-label="Ledger">
        <thead><tr><th>Date</th><th>Document</th><th /><th className="num">Paid / returned</th><th className="num">Billed</th><th className="num">We owe</th></tr></thead>
        <tbody>
          {entries.map((entry) => <tr key={entry.id}>
            <td>{dateOf(entry.at)}</td><td>{entry.docNumber}</td><td>{entry.memo}</td>
            <td className="num">{entry.debitPaisa ? formatPkr(entry.debitPaisa) : ""}</td><td className="num">{entry.creditPaisa ? formatPkr(entry.creditPaisa) : ""}</td>
            <td className="num">{owedText(entry.balanceAfterPaisa)}</td>
          </tr>)}
          {entries.length === 0 && <tr><td colSpan={6} className="muted">No entries yet.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
        <span className="muted">Page {page} of {pageCount}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Older</button>
      </div>
    </section>
  </div>;
}
