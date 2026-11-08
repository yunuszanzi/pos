import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getGoodsReceiptById } from "../../api/purchasingApi";
import { ErrorMessage, PageTitle, SelectInput } from "../../app/FormElements";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { momentDayText } from "./dayText";
import { usePrintSetup } from "./usePrintSetup";

/** One posted goods receipt: what came, at what price, and into which stock. It can be printed again at any time. */
export function GoodsReceiptPage() {
  const { id = "" } = useParams();
  const setup = usePrintSetup();
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const receipt = useQuery({ queryKey: ["goods-receipt", id], queryFn: () => getGoodsReceiptById(id) });

  if (receipt.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (receipt.isError) return <div className="content"><ErrorMessage>{receipt.error.message}</ErrorMessage></div>;
  const data = receipt.data;
  const showCost = data.totalPaisa !== undefined;

  function print() {
    if (!setup) return;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat,
      goodsReceipt: {
        number: data.number, receivedAt: data.receivedAt, supplierName: data.supplierName, branchName: data.branchName, locationName: data.locationName,
        orderNumber: data.orderNumber, supplierRef: data.supplierRef, receivedBy: data.receivedBy, note: data.note,
        ...(data.totalPaisa !== undefined ? { totalPaisa: data.totalPaisa } : {}),
        lines: data.lines.map((line) => ({
          productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity,
          ...(line.unitCostPaisa !== undefined ? { unitCostPaisa: line.unitCostPaisa, lineTotalPaisa: line.lineValuePaisa } : {}),
        })),
      },
    });
  }

  return <div className="content">
    <PageTitle title={`${data.number} — goods received`} description={`From ${data.supplierName} into ${data.locationName}, on ${momentDayText(data.receivedAt)}.`} />
    <p><Link className="text-button" to="/goods-receipts">← Back to goods receipts</Link></p>
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Supplier</dt><dd>{data.supplierName}</dd></div>
        {data.orderNumber && <div><dt>Order</dt><dd><Link className="text-button" to={`/purchase-orders/${data.orderId}`}>{data.orderNumber}</Link></dd></div>}
        {data.supplierRef && <div><dt>Supplier's reference</dt><dd>{data.supplierRef}</dd></div>}
        {data.receivedBy && <div><dt>Received by</dt><dd>{data.receivedBy}</dd></div>}
        {showCost && <div className="grand"><dt>Value received</dt><dd data-testid="receipt-total">{formatPkr(data.totalPaisa!)}</dd></div>}
      </dl>
      {data.note && <p className="muted">{data.note}</p>}
      {setup && <div className="pay-row">
        <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={print}>Print receipt</button>
      </div>}
    </section>
    <section className="panel stack">
      <h2>Items</h2>
      <div className="table-scroll"><table aria-label="Receipt items">
        <thead><tr><th>Item</th><th>Unit</th><th className="num">Received</th><th className="num">In pieces</th>{showCost && <><th className="num">Price</th><th className="num">Cost per piece</th><th className="num">Value</th></>}</tr></thead>
        <tbody>
          {data.lines.map((line) => <tr key={line.id}>
            <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
            <td>{line.unitName}</td><td className="num">{line.quantity}</td><td className="num">{line.qtyBase}</td>
            {showCost && <><td className="num">{formatPkr(line.unitCostPaisa ?? 0)}</td><td className="num">{formatPkr(line.costPerBasePaisa ?? 0)}</td><td className="num">{formatPkr(line.lineValuePaisa ?? 0)}</td></>}
          </tr>)}
        </tbody>
      </table></div>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
