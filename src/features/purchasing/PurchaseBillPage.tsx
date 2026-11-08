import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatBps, formatPkr } from "../../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getPurchaseBillById } from "../../api/billsApi";
import { ErrorMessage, PageTitle, SelectInput } from "../../app/FormElements";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { dayText } from "./dayText";
import { usePrintSetup } from "./usePrintSetup";

/** One entered supplier bill: what was billed, how freight was shared, and what each line did to the cost of stock. */
export function PurchaseBillPage() {
  const { id = "" } = useParams();
  const setup = usePrintSetup();
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const bill = useQuery({ queryKey: ["purchase-bill", id], queryFn: () => getPurchaseBillById(id) });

  if (bill.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (bill.isError) return <div className="content"><ErrorMessage>{bill.error.message}</ErrorMessage></div>;
  const data = bill.data;

  function print() {
    if (!setup) return;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat,
      purchaseBill: {
        number: data.number, supplierInvoiceNo: data.supplierInvoiceNo, supplierName: data.supplierName, branchName: data.branchName, billDate: data.billDate, dueDate: data.dueDate, note: data.note,
        subtotalPaisa: data.subtotalPaisa, chargesPaisa: data.chargesPaisa, taxPaisa: data.taxPaisa, totalPaisa: data.totalPaisa,
        lines: data.lines.map((line) => ({ productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity, unitCostPaisa: line.unitCostPaisa, lineValuePaisa: line.lineValuePaisa })),
        charges: data.charges.map((charge) => ({ description: charge.description, amountPaisa: charge.amountPaisa })),
      },
    });
  }

  return <div className="content">
    <PageTitle title={`${data.number} — supplier bill`} description={`${data.supplierName}'s invoice ${data.supplierInvoiceNo}, dated ${dayText(data.billDate)}, due ${dayText(data.dueDate)}.`} />
    <p><Link className="text-button" to="/purchase-bills">← Back to supplier bills</Link></p>
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Items</dt><dd>{formatPkr(data.subtotalPaisa)}</dd></div>
        {data.charges.map((charge) => <div key={charge.id}><dt>{charge.description}</dt><dd>{formatPkr(charge.amountPaisa)}</dd></div>)}
        {data.taxPaisa > 0 && <div><dt>Input tax</dt><dd>{formatPkr(data.taxPaisa)}</dd></div>}
        <div className="grand"><dt>Bill total</dt><dd data-testid="bill-total">{formatPkr(data.totalPaisa)}</dd></div>
        {data.settledPaisa > 0 && <div><dt>Paid or credited</dt><dd>{formatPkr(data.settledPaisa)}</dd></div>}
        <div><dt>Still owing</dt><dd data-testid="bill-outstanding">{formatPkr(data.outstandingPaisa)}</dd></div>
      </dl>
      {data.settlements.length > 0 && <p className="muted">Settled by: {data.settlements.map((row) => `${row.number} (${formatPkr(row.amountPaisa)})`).join(", ")}.</p>}
      {data.note && <p className="muted">{data.note}</p>}
      {setup && <div className="pay-row">
        <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={print}>Print bill</button>
      </div>}
    </section>
    <section className="panel stack">
      <h2>Items</h2>
      <div className="table-scroll"><table aria-label="Bill items">
        <thead><tr><th>Item</th><th>Receipt</th><th className="num">Billed</th><th className="num">Price</th><th className="num">Value</th><th className="num">Tax</th><th className="num">Freight share</th><th className="num">Added to stock cost</th></tr></thead>
        <tbody>
          {data.lines.map((line) => <tr key={line.id}>
            <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
            <td>{line.receiptNumber}</td><td className="num">{line.quantity} {line.unitName}</td><td className="num">{formatPkr(line.unitCostPaisa)}</td>
            <td className="num">{formatPkr(line.lineValuePaisa)}</td>
            <td className="num">{line.taxPaisa ? `${formatPkr(line.taxPaisa)} (${formatBps(line.taxRateBps)}%)` : ""}</td>
            <td className="num">{line.chargeSharePaisa ? formatPkr(line.chargeSharePaisa) : ""}</td>
            <td className="num">{line.absorbedPaisa === 0 ? "" : line.absorbedPaisa < 0 ? `-${formatPkr(-line.absorbedPaisa)}` : formatPkr(line.absorbedPaisa)}</td>
          </tr>)}
        </tbody>
      </table></div>
      <p className="muted">"Added to stock cost" is the part of freight and price differences that the stock still on hand carries; goods already sold keep the cost they were sold at.</p>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
