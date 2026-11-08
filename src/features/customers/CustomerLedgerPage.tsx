import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { reminderMessage, whatsappLink } from "../../../shared/khata";
import { formatPkr } from "../../../shared/money";
import { formatDocumentDate } from "../../../shared/receipt";
import { getCustomerLedger } from "../../api/customersApi";
import { getAppBootstrapData } from "../../api/posApi";
import { ErrorMessage, PageTitle } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { useTerminalStore } from "../../app/terminalStore";
import { ReceivePaymentDialog } from "./ReceivePaymentDialog";

/** A customer's khata: what they owe, which invoices are open, and every entry with the balance after it. */
export function CustomerLedgerPage() {
  const { id = "" } = useParams();
  const mayReceive = useCan("customers.receive_payment");
  const maySell = useCan("sales.create");
  const canReceive = mayReceive && maySell;
  const terminalId = useTerminalStore((state) => state.terminalId);
  const [page, setPage] = useState(1);
  const [receiving, setReceiving] = useState(false);
  const ledger = useQuery({ queryKey: ["customer-ledger", id, page], queryFn: ({ signal }) => getCustomerLedger(id, page, signal), placeholderData: keepPreviousData });
  // The payment methods and the print details come from the same bootstrap call the till makes, shared by its cache key.
  const setup = useQuery({ queryKey: ["pos-bootstrap", terminalId], queryFn: getAppBootstrapData, staleTime: Infinity, enabled: canReceive });

  if (ledger.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (ledger.isError) return <div className="content"><ErrorMessage>{ledger.error.message}</ErrorMessage></div>;
  const { customer, openInvoices, entries, total, pageSize } = ledger.data;
  const settings = setup.data?.settings;
  const dateOf = (iso: string) => formatDocumentDate(iso, settings?.dateFormat ?? "dd/MM/yyyy", settings?.timezone ?? "Asia/Karachi");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const overdue = openInvoices.some((invoice) => invoice.overdue);
  // A reminder only makes sense while they owe something. The person sends it from WhatsApp; nothing is sent by the system.
  const reminder = customer.balancePaisa > 0 && (customer.whatsapp || customer.phone)
    ? whatsappLink(customer.whatsapp || customer.phone, reminderMessage({ customerName: customer.name, businessName: setup.data?.business.tradeName ?? "us", balancePaisa: customer.balancePaisa }))
    : null;

  return <div className="content">
    <PageTitle title={`${customer.name} — khata`} description="Invoices add to what the customer owes; payments and returns take it down." />
    <p><Link className="text-button" to="/customers">← Back to customers</Link></p>
    <section className="panel stack">
      <dl className="totals">
        <div className="grand"><dt>{customer.balancePaisa < 0 ? "Credit on account" : "Owes"}</dt><dd data-testid="khata-balance">{formatPkr(Math.abs(customer.balancePaisa))}</dd></div>
        <div><dt>Credit limit</dt><dd>{customer.creditLimitPaisa > 0 ? formatPkr(customer.creditLimitPaisa) : "No credit"}</dd></div>
        {customer.termsDays > 0 && <div><dt>Payment terms</dt><dd>{customer.termsDays} days</dd></div>}
      </dl>
      {overdue && <p className="notice error" role="status">This customer has invoices past their payment terms.</p>}
      <div className="button-row">
        {canReceive && setup.data && <button className="button primary" onClick={() => setReceiving(true)}>Receive payment</button>}
        <Link className="button secondary" to={`/customers/${customer.id}/statement`}>Statement</Link>
        {reminder && <a className="button secondary" href={reminder} target="_blank" rel="noreferrer">Remind on WhatsApp</a>}
      </div>
    </section>

    <section className="panel stack">
      <h2>Open invoices</h2>
      <div className="table-scroll"><table aria-label="Open invoices">
        <thead><tr><th>Invoice</th><th>Date</th><th className="num">Total</th><th className="num">Owing</th><th /></tr></thead>
        <tbody>
          {openInvoices.map((invoice) => <tr key={invoice.invoiceId}>
            <td>{invoice.number}</td><td>{dateOf(invoice.postedAt)}</td><td className="num">{formatPkr(invoice.totalPaisa)}</td>
            <td className="num">{formatPkr(invoice.outstandingPaisa)}</td><td>{invoice.overdue && <span className="status">Overdue</span>}</td>
          </tr>)}
          {openInvoices.length === 0 && <tr><td colSpan={5} className="muted">Nothing is owing on any invoice.</td></tr>}
        </tbody>
      </table></div>
    </section>

    <section className="panel stack">
      <h2>Ledger</h2>
      <div className="table-scroll"><table aria-label="Ledger">
        <thead><tr><th>Date</th><th>Document</th><th /><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {entries.map((entry) => <tr key={entry.id}>
            <td>{dateOf(entry.at)}</td><td>{entry.docNumber}</td><td>{entry.memo}</td>
            <td className="num">{entry.debitPaisa ? formatPkr(entry.debitPaisa) : ""}</td><td className="num">{entry.creditPaisa ? formatPkr(entry.creditPaisa) : ""}</td>
            <td className="num">{formatPkr(entry.balanceAfterPaisa)}</td>
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

    {receiving && setup.data && <ReceivePaymentDialog customerId={customer.id} methods={setup.data.paymentMethods} onClose={() => setReceiving(false)}
      print={{ business: setup.data.business, dateFormat: setup.data.settings.dateFormat, timezone: setup.data.settings.timezone, defaultFormat: setup.data.terminal?.defaultPrintFormat ?? "a4" }} />}
  </div>;
}
