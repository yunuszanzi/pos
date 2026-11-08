import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { formatDocumentDate } from "../../../shared/receipt";
import { getSupplierLedger, getSupplierOpenBills } from "../../api/suppliersApi";
import { ErrorMessage, PageTitle } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText } from "../purchasing/dayText";
import { usePrintSetup } from "../purchasing/usePrintSetup";
import { PaySupplierDialog } from "./PaySupplierDialog";

const owedText = (paisa: number) => (paisa < 0 ? `${formatPkr(-paisa)} Dr` : formatPkr(paisa));

/** What the shop owes a supplier and how it came about: bills and opening balances add to it, payments and returns take it down. */
export function SupplierLedgerPage() {
  const { id = "" } = useParams();
  const mayPay = useCan("suppliers.pay");
  const setup = usePrintSetup();
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState(false);
  const ledger = useQuery({ queryKey: ["supplier-ledger", id, page], queryFn: ({ signal }) => getSupplierLedger(id, page, signal), placeholderData: keepPreviousData });
  const openBills = useQuery({ queryKey: ["supplier-open-bills", id], queryFn: ({ signal }) => getSupplierOpenBills(id, signal) });

  if (ledger.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (ledger.isError) return <div className="content"><ErrorMessage>{ledger.error.message}</ErrorMessage></div>;
  const { supplier, entries, total, pageSize } = ledger.data;
  const dateOf = (iso: string) => formatDocumentDate(iso, setup?.dateFormat ?? "dd/MM/yyyy", setup?.timezone ?? "Asia/Karachi").split(" ")[0];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const overdue = (openBills.data ?? []).some((bill) => bill.overdue);

  return <div className="content">
    <PageTitle title={`${supplier.name} — ledger`} description="Bills add to what you owe; payments and returns take it down." />
    <p><Link className="text-button" to="/suppliers">← Back to suppliers</Link></p>
    <section className="panel stack">
      <dl className="totals">
        <div className="grand"><dt>{supplier.balancePaisa < 0 ? "Credit with them" : "We owe"}</dt><dd data-testid="supplier-balance">{formatPkr(Math.abs(supplier.balancePaisa))}</dd></div>
        {supplier.termsDays > 0 && <div><dt>Payment terms</dt><dd>{supplier.termsDays} days</dd></div>}
      </dl>
      {overdue && <p className="notice error" role="status">This supplier has bills past their due date.</p>}
      <div className="button-row">
        {mayPay && setup && <button className="button primary" onClick={() => setPaying(true)}>Pay supplier</button>}
        <Link className="button secondary" to="/supplier-payments">Payments made</Link>
      </div>
    </section>

    <section className="panel stack">
      <h2>Open bills</h2>
      <div className="table-scroll"><table aria-label="Open bills">
        <thead><tr><th>Bill</th><th>Their invoice</th><th>Date</th><th>Due</th><th className="num">Total</th><th className="num">Owing</th><th /></tr></thead>
        <tbody>
          {(openBills.data ?? []).map((bill) => <tr key={bill.billId}>
            <td><Link className="text-button" to={`/purchase-bills/${bill.billId}`}>{bill.number}</Link></td><td>{bill.supplierInvoiceNo}</td><td>{dayText(bill.billDate)}</td><td>{dayText(bill.dueDate)}</td>
            <td className="num">{formatPkr(bill.totalPaisa)}</td><td className="num">{formatPkr(bill.outstandingPaisa)}</td><td>{bill.overdue && <span className="status">Overdue</span>}</td>
          </tr>)}
          {openBills.isSuccess && openBills.data.length === 0 && <tr><td colSpan={7} className="muted">Nothing is owing on any bill.</td></tr>}
        </tbody>
      </table></div>
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
    {paying && setup && <PaySupplierDialog supplier={{ id: supplier.id, name: supplier.name }} owedPaisa={supplier.balancePaisa} setup={setup} onClose={() => setPaying(false)} />}
  </div>;
}
