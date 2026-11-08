import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatBps, formatPkr } from "../../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getPurchaseReturnById } from "../../api/purchasingApi";
import { ErrorMessage, PageTitle, SelectInput } from "../../app/FormElements";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { momentDayText } from "./dayText";
import { usePrintSetup } from "./usePrintSetup";

/** One purchase return (a debit note): what went back, what the supplier credited, and where the credit went. */
export function PurchaseReturnPage() {
  const { id = "" } = useParams();
  const setup = usePrintSetup();
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const note = useQuery({ queryKey: ["purchase-return", id], queryFn: () => getPurchaseReturnById(id) });

  if (note.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (note.isError) return <div className="content"><ErrorMessage>{note.error.message}</ErrorMessage></div>;
  const data = note.data;

  function print() {
    if (!setup) return;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat,
      purchaseReturn: {
        number: data.number, postedAt: data.postedAt, supplierName: data.supplierName, branchName: data.branchName, receiptNumber: data.receiptNumber, reason: data.reason,
        subtotalPaisa: data.subtotalPaisa, taxPaisa: data.taxPaisa, totalPaisa: data.totalPaisa, settledBillsPaisa: data.settledBillsPaisa, onAccountPaisa: data.onAccountPaisa,
        lines: data.lines.map((line) => ({ productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity, unitCostPaisa: line.unitCostPaisa, lineValuePaisa: line.lineValuePaisa })),
      },
    });
  }

  return <div className="content">
    <PageTitle title={`${data.number} — purchase return`} description={`To ${data.supplierName}, from ${data.receiptNumber}, on ${momentDayText(data.postedAt)}.`} />
    <p><Link className="text-button" to="/purchase-returns">← Back to purchase returns</Link></p>
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Goods returned</dt><dd>{formatPkr(data.subtotalPaisa)}</dd></div>
        {data.taxPaisa > 0 && <div><dt>Input tax reversed</dt><dd>{formatPkr(data.taxPaisa)}</dd></div>}
        <div className="grand"><dt>Credit from supplier</dt><dd data-testid="return-total">{formatPkr(data.totalPaisa)}</dd></div>
        {data.settledBillsPaisa > 0 && <div><dt>Taken off bills</dt><dd data-testid="return-settled">{formatPkr(data.settledBillsPaisa)}</dd></div>}
        {data.onAccountPaisa > 0 && <div><dt>Credit on their account</dt><dd data-testid="return-on-account">{formatPkr(data.onAccountPaisa)}</dd></div>}
        <div><dt>{data.supplierBalancePaisa < 0 ? "Credit with them now" : "We owe them now"}</dt><dd>{formatPkr(Math.abs(data.supplierBalancePaisa))}</dd></div>
      </dl>
      {data.reason && <p className="muted">{data.reason}</p>}
      {data.allocations.length > 0 && <p className="muted">Taken off: {data.allocations.map((row) => `${row.supplierInvoiceNo} (${formatPkr(row.amountPaisa)})`).join(", ")}.</p>}
      {setup && <div className="pay-row">
        <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={print}>Print debit note</button>
      </div>}
    </section>
    <section className="panel stack">
      <h2>Items</h2>
      <div className="table-scroll"><table aria-label="Returned items">
        <thead><tr><th>Item</th><th>Unit</th><th className="num">Returned</th><th className="num">Credit for one</th><th className="num">Value</th><th className="num">Tax</th></tr></thead>
        <tbody>
          {data.lines.map((line) => <tr key={line.id}>
            <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
            <td>{line.unitName}</td><td className="num">{line.quantity}</td><td className="num">{formatPkr(line.unitCostPaisa)}</td><td className="num">{formatPkr(line.lineValuePaisa)}</td>
            <td className="num">{line.taxPaisa ? `${formatPkr(line.taxPaisa)} (${formatBps(line.taxRateBps)}%)` : ""}</td>
          </tr>)}
        </tbody>
      </table></div>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
