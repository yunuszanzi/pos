import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { statementMessage, whatsappLink } from "../../../shared/khata";
import { formatPkr } from "../../../shared/money";
import { formatDocumentDate, printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getCustomerStatement } from "../../api/customersApi";
import { getAppBootstrapData } from "../../api/posApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { useTerminalStore } from "../../app/terminalStore";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";

const balanceText = (paisa: number) => (paisa < 0 ? `${formatPkr(-paisa)} Cr` : formatPkr(paisa));

/** A customer's statement for a period: where they started, what happened, where they ended. Printable, and shareable on WhatsApp. */
export function CustomerStatementPage() {
  const { id = "" } = useParams();
  const maySell = useCan("sales.create");
  const terminalId = useTerminalStore((state) => state.terminalId);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [format, setFormat] = useState<PrintFormat>("a4");
  const [job, setJob] = useState<PrintJob | null>(null);
  const statement = useQuery({ queryKey: ["customer-statement", id, from, to], queryFn: ({ signal }) => getCustomerStatement(id, { from, to }, signal), placeholderData: keepPreviousData });
  // The business details printed on a statement come from the same bootstrap call the till makes, shared by its cache key.
  const setup = useQuery({ queryKey: ["pos-bootstrap", terminalId], queryFn: getAppBootstrapData, staleTime: Infinity, enabled: maySell });

  if (statement.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (statement.isError) return <div className="content"><ErrorMessage>{statement.error.message}</ErrorMessage></div>;
  const { customer, period, entries, summary } = statement.data;
  const settings = setup.data?.settings;
  const dateOf = (iso: string) => formatDocumentDate(iso, settings?.dateFormat ?? "dd/MM/yyyy", settings?.timezone ?? "Asia/Karachi").split(" ")[0];
  const link = whatsappLink(customer.whatsapp || customer.phone, statementMessage({
    customerName: customer.name, businessName: setup.data?.business.tradeName ?? "us", from: period.from, to: period.to, closingPaisa: summary.closingPaisa,
  }));

  function print() {
    if (!setup.data) return;
    setJob({
      business: setup.data.business, dateFormat: setup.data.settings.dateFormat, timezone: setup.data.settings.timezone, format,
      statement: { customerName: customer.name, customerPhone: customer.phone, customerAddress: customer.address, from: period.from, to: period.to, summary, entries },
    });
  }

  return <div className="content">
    <PageTitle title={`${customer.name} — statement`} description="Opening balance, plus invoices, minus payments and returns, gives the closing balance." />
    <p><Link className="text-button" to={`/customers/${customer.id}/ledger`}>← Back to the khata</Link></p>
    <section className="panel stack">
      <div className="form-grid">
        <label className="field"><span>From</span><TextInput type="date" aria-label="From" value={from || period.from} max={to || period.to} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="field"><span>To</span><TextInput type="date" aria-label="To" value={to || period.to} min={from || period.from} onChange={(event) => setTo(event.target.value)} /></label>
        {maySell && <label className="field"><span>Paper</span>
          <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
            {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
          </SelectInput></label>}
      </div>
      <div className="button-row">
        {maySell && <button className="button primary" disabled={!setup.data || entries.length === 0 && summary.openingPaisa === 0} onClick={print}>Print statement</button>}
        {link && <a className="button secondary" href={link} target="_blank" rel="noreferrer">Send on WhatsApp</a>}
        {!link && <span className="muted">Add a WhatsApp or phone number to the customer to send this on WhatsApp.</span>}
      </div>
    </section>

    <section className="panel stack">
      <dl className="totals" aria-label="Statement summary">
        <div><dt>Opening balance</dt><dd data-testid="statement-opening">{balanceText(summary.openingPaisa)}</dd></div>
        <div><dt>Invoices</dt><dd data-testid="statement-invoices">{formatPkr(summary.invoicesPaisa)}</dd></div>
        <div><dt>Payments received</dt><dd data-testid="statement-payments">{formatPkr(summary.paymentsPaisa)}</dd></div>
        <div><dt>Returns</dt><dd data-testid="statement-returns">{formatPkr(summary.returnsPaisa)}</dd></div>
        {summary.refundsPaisa > 0 && <div><dt>Refunds paid out</dt><dd>{formatPkr(summary.refundsPaisa)}</dd></div>}
        {summary.otherPaisa !== 0 && <div><dt>Opening balance / adjustments</dt><dd>{balanceText(summary.otherPaisa)}</dd></div>}
        <div className="grand"><dt>{summary.closingPaisa < 0 ? "Credit with us" : "Balance due"}</dt><dd data-testid="statement-closing">{formatPkr(Math.abs(summary.closingPaisa))}</dd></div>
      </dl>
      <div className="table-scroll"><table aria-label="Statement">
        <thead><tr><th>Date</th><th>Document</th><th /><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
        <tbody>
          <tr><td>{dateOf(`${period.from}T12:00:00Z`)}</td><td colSpan={4} className="muted">Opening balance</td><td className="num">{balanceText(summary.openingPaisa)}</td></tr>
          {entries.map((entry) => <tr key={entry.id}>
            <td>{dateOf(entry.at)}</td><td>{entry.docNumber}</td><td>{entry.memo}</td>
            <td className="num">{entry.debitPaisa ? formatPkr(entry.debitPaisa) : ""}</td><td className="num">{entry.creditPaisa ? formatPkr(entry.creditPaisa) : ""}</td>
            <td className="num">{balanceText(entry.balanceAfterPaisa)}</td>
          </tr>)}
          {entries.length === 0 && <tr><td colSpan={6} className="muted">Nothing happened on this account in this period.</td></tr>}
        </tbody>
      </table></div>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
