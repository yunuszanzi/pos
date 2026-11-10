import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatBps, formatPkr } from "../../../shared/money";
import { formatDay, printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getSalesInvoiceById, type Invoice } from "../../api/salesInvoicesApi";
import { ErrorMessage, PageTitle, SelectInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { invoicePrintDoc } from "../../pos/documentPrint";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { dayText, momentDayText } from "../purchasing/dayText";
import { ShareLinkButton } from "../sharing/ShareLinkButton";
import { usePrintSetup } from "../purchasing/usePrintSetup";

/** One back-office invoice: the buyer, the terms and due date, what was billed, and what is still owing. */
export function InvoicePage() {
  const { id = "" } = useParams();
  const mayLedger = useCan("customers.ledger");
  const setup = usePrintSetup();
  // A desk invoice is a sheet by default, whatever format the till prints.
  const [format, setFormat] = useState<PrintFormat>("a4");
  const [job, setJob] = useState<PrintJob | null>(null);
  const found = useQuery({ queryKey: ["sales-invoice", id], queryFn: () => getSalesInvoiceById(id), staleTime: 0 });

  if (found.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (found.isError) return <div className="content"><ErrorMessage>{found.error.message}</ErrorMessage></div>;
  const data: Invoice = found.data;
  const taxInvoice = Boolean(data.buyerNtn || data.buyerStrn);
  const owing = data.outstandingPaisa ?? data.balancePaisa;

  function print() {
    if (!setup) return;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format,
      invoice: invoicePrintDoc(data),
    });
  }

  const message = `Dear ${data.buyerName || data.customerName}, ${setup?.business.tradeName ?? ""} invoice ${data.number} for ${formatPkr(data.totalPaisa)}${data.dueDate ? `, due ${formatDay(data.dueDate, setup?.dateFormat ?? "dd/MM/yyyy")}` : ""}.`;

  return <div className="content">
    <PageTitle title={`${data.number} — ${taxInvoice ? "Tax invoice" : "Invoice"}`} description={`For ${data.buyerName || data.customerName}, posted ${momentDayText(data.postedAt)}.`} />
    <p>
      <Link className="text-button" to="/invoices">← Back to invoices</Link>
      {data.orderId && <> · <Link className="text-button" to={`/sales-orders/${data.orderId}`}>Order {data.orderNumber}</Link></>}
      {data.quotationId && <> · <Link className="text-button" to={`/quotations/${data.quotationId}`}>Quotation</Link></>}
    </p>
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Customer</dt><dd>{data.buyerName || data.customerName}</dd></div>
        {(data.buyerNtn || data.buyerStrn) && <div><dt>Buyer registration</dt><dd>{[data.buyerNtn && `NTN ${data.buyerNtn}`, data.buyerStrn && `STRN ${data.buyerStrn}`].filter(Boolean).join("  ")}</dd></div>}
        {data.buyerAddress && <div><dt>Address</dt><dd>{data.buyerAddress}</dd></div>}
        {data.customerPo && <div><dt>Their PO</dt><dd>{data.customerPo}</dd></div>}
        <div><dt>Terms</dt><dd>{data.termsDays === 0 ? "Due on receipt" : `${data.termsDays} days`}</dd></div>
        <div><dt>Due date</dt><dd>{dayText(data.dueDate)}</dd></div>
        <div><dt>Subtotal</dt><dd>{formatPkr(data.grossPaisa)}</dd></div>
        {data.lineDiscountPaisa + data.invoiceDiscountPaisa > 0 && <div><dt>Discounts</dt><dd>-{formatPkr(data.lineDiscountPaisa + data.invoiceDiscountPaisa)}</dd></div>}
        <div><dt>{data.taxMode === "inclusive" ? "Tax (included)" : "Tax"}</dt><dd>{formatPkr(data.taxPaisa)}</dd></div>
        <div className="grand"><dt>Invoice total</dt><dd data-testid="invoice-total">{formatPkr(data.totalPaisa)}</dd></div>
        <div><dt>Still owing</dt><dd data-testid="invoice-owing">{formatPkr(owing)}</dd></div>
      </dl>
      {data.note && <p className="muted">{data.note}</p>}
      <div className="button-row">
        {data.customerId && mayLedger && owing > 0 && <Link className="button primary" to={`/customers/${data.customerId}/ledger`}>Receive a payment (khata)</Link>}
        <ShareLinkButton type="invoice" id={data.id} message={(url) => `${message} ${url}`} />
      </div>
      {setup && <div className="pay-row">
        <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={print}>Print invoice</button>
      </div>}
    </section>

    <section className="panel stack">
      <h2>Items</h2>
      <div className="table-scroll"><table aria-label="Invoice items">
        <thead><tr><th>Item</th><th>Unit</th><th className="num">Quantity</th><th className="num">Price</th><th className="num">Discount</th><th className="num">Tax</th><th className="num">Total</th></tr></thead>
        <tbody>{data.lines.map((line) => <tr key={line.lineNo}>
          <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
          <td>{line.unitName}</td><td className="num">{line.quantity}</td><td className="num">{formatPkr(line.unitPricePaisa)}</td>
          <td className="num">{line.lineDiscountPaisa + line.invoiceDiscountSharePaisa > 0 ? `-${formatPkr(line.lineDiscountPaisa + line.invoiceDiscountSharePaisa)}` : ""}</td>
          <td className="num">{line.taxRateBps ? `${formatBps(line.taxRateBps)}% · ${formatPkr(line.taxPaisa)}` : ""}</td>
          <td className="num">{formatPkr(line.totalPaisa)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
