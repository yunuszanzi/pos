import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatBps, formatPkr } from "../../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { salesOrderStatusLabels } from "../../../shared/schemas/salesOrders";
import { getSalesOrderById, moveSalesOrder, type SalesOrder } from "../../api/salesOrdersApi";
import { ErrorMessage, PageTitle, SelectInput, SuccessMessage } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { challanStatusLabels } from "../../../shared/schemas/deliveryChallans";
import { dayText } from "../purchasing/dayText";
import { usePrintSetup } from "../purchasing/usePrintSetup";
import { MakeInvoicePanel } from "../invoices/MakeInvoicePanel";
import { WriteChallanPanel } from "./WriteChallanPanel";

type Move = "cancel" | "close";
const moves: Record<Move, { label: string; done: string }> = {
  cancel: { label: "Cancel order", done: "cancelled; its stock is free again" },
  close: { label: "Close order", done: "closed; what was not delivered is free again" },
};

/** One sales order: what was ordered, what has gone out and been billed, and what can be done with it next. */
export function SalesOrderPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayManage = useCan("sales_orders.manage");
  const mayDeliver = useCan("delivery.manage");
  const mayInvoice = useCan("invoices.create");
  const setup = usePrintSetup();
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per kind of move on this order, so pressing twice cannot do it twice.
  const keys = useRef(new Map<Move, string>());
  const found = useQuery({ queryKey: ["sales-order", id], queryFn: () => getSalesOrderById(id), staleTime: 0 });

  if (found.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (found.isError) return <div className="content"><ErrorMessage>{found.error.message}</ErrorMessage></div>;
  const data: SalesOrder = found.data;
  const can = (move: Move) => mayManage && ((move === "cancel" && data.status === "open") || (move === "close" && (data.status === "partly_delivered" || data.status === "delivered")));

  async function move(action: Move) {
    setBusy(true);
    setError("");
    setNotice("");
    if (!keys.current.has(action)) keys.current.set(action, `so-${action}-${crypto.randomUUID()}`);
    try {
      await moveSalesOrder(id, action, keys.current.get(action)!);
      setNotice(`${data.number} ${moves[action].done}.`);
      // Reserved stock changed, so the stock lists must be asked again.
      await Promise.all(["sales-order", "sales-orders", "stock"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the order");
    } finally {
      setBusy(false);
    }
  }

  function print() {
    if (!setup) return;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat,
      salesOrder: {
        number: data.number, orderDate: data.orderDate, deliveryDate: data.deliveryDate, branchName: data.branchName, customerName: data.customerName, customerPhone: data.customerPhone,
        customerNtn: data.customerNtn, customerStrn: data.customerStrn, customerPo: data.customerPo, quotationNumber: data.quotationNumber, deliveryAddress: data.deliveryAddress,
        note: data.note, taxMode: data.taxMode, grossPaisa: data.grossPaisa, lineDiscountPaisa: data.lineDiscountPaisa, invoiceDiscountPaisa: data.invoiceDiscountPaisa,
        taxPaisa: data.taxPaisa, roundingPaisa: data.roundingPaisa, totalPaisa: data.totalPaisa,
        lines: data.lines.map((line) => ({
          productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity, unitPricePaisa: line.unitPricePaisa,
          lineDiscountPaisa: line.lineDiscountPaisa, invoiceDiscountSharePaisa: line.invoiceDiscountSharePaisa, taxRateBps: line.taxRateBps, taxPaisa: line.taxPaisa, totalPaisa: line.totalPaisa,
        })),
      },
    });
  }

  return <div className="content">
    <PageTitle title={`${data.number} — ${salesOrderStatusLabels[data.status]}`} description={`For ${data.customerName}, stock from ${data.locationName}.`} />
    <p><Link className="text-button" to="/sales-orders">← Back to sales orders</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Customer</dt><dd>{data.customerName}{data.customerPhone ? ` · ${data.customerPhone}` : ""}</dd></div>
        <div><dt>Ordered on</dt><dd>{dayText(data.orderDate)}</dd></div>
        {data.deliveryDate && <div><dt>Deliver by</dt><dd>{dayText(data.deliveryDate)}</dd></div>}
        {data.customerPo && <div><dt>Their PO</dt><dd>{data.customerPo}</dd></div>}
        {data.quotationId && <div><dt>From quotation</dt><dd><Link className="text-button" to={`/quotations/${data.quotationId}`}>{data.quotationNumber}</Link></dd></div>}
        <div><dt>Subtotal</dt><dd>{formatPkr(data.grossPaisa)}</dd></div>
        {data.lineDiscountPaisa + data.invoiceDiscountPaisa > 0 && <div><dt>Discounts</dt><dd>-{formatPkr(data.lineDiscountPaisa + data.invoiceDiscountPaisa)}</dd></div>}
        <div><dt>{data.taxMode === "inclusive" ? "Tax (included)" : "Tax"}</dt><dd>{formatPkr(data.taxPaisa)}</dd></div>
        <div className="grand"><dt>Order total</dt><dd data-testid="order-total">{formatPkr(data.totalPaisa)}</dd></div>
      </dl>
      {data.deliveryAddress && <p><strong>Deliver to:</strong> {data.deliveryAddress}</p>}
      {data.note && <p className="muted">{data.note}</p>}
      <div className="button-row">
        {can("close") && <button className="button secondary" disabled={busy} onClick={() => void move("close")}>{moves.close.label}</button>}
        {can("cancel") && <button className="button secondary" disabled={busy} onClick={() => void move("cancel")}>{moves.cancel.label}</button>}
      </div>
      {setup && <div className="pay-row">
        <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={print}>Print order</button>
      </div>}
    </section>

    <section className="panel stack">
      <h2>Items</h2>
      <div className="table-scroll"><table aria-label="Order items">
        <thead><tr><th>Item</th><th>Unit</th><th className="num">Ordered</th><th className="num">Delivered</th><th className="num">Billed</th><th className="num">Price</th><th className="num">Tax</th><th className="num">Total</th></tr></thead>
        <tbody>
          {data.lines.map((line) => <tr key={line.id}>
            <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
            <td>{line.unitName}</td><td className="num">{line.quantity}</td><td className="num">{line.deliveredBase}</td><td className="num">{line.invoicedBase}</td>
            <td className="num">{formatPkr(line.unitPricePaisa)}</td>
            <td className="num">{line.taxRateBps ? `${formatBps(line.taxRateBps)}% · ${formatPkr(line.taxPaisa)}` : ""}</td>
            <td className="num">{formatPkr(line.totalPaisa)}</td>
          </tr>)}
        </tbody>
      </table></div>
      <p className="muted">"Delivered" and "Billed" count in pieces (the base unit). {data.status === "open" || data.status === "partly_delivered" ? "The stock still to be delivered is held for this order." : ""}</p>
    </section>
    {mayDeliver && (data.status === "open" || data.status === "partly_delivered") && <WriteChallanPanel order={data} />}

    {mayInvoice && data.status !== "cancelled" && <MakeInvoicePanel source={{ kind: "order", order: data }} />}

    {data.invoices.length > 0 && <section className="panel stack">
      <h2>Invoices</h2>
      <div className="table-scroll"><table aria-label="Invoices for this order">
        <thead><tr><th>Invoice</th><th>Due</th><th className="num">Total</th></tr></thead>
        <tbody>{data.invoices.map((invoice) => <tr key={invoice.id}>
          <td><Link className="text-button" to={`/invoices/${invoice.id}`}>{invoice.number}</Link></td>
          <td>{dayText(invoice.dueDate)}</td><td className="num">{formatPkr(invoice.totalPaisa)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}

    {data.challans.length > 0 && <section className="panel stack">
      <h2>Delivery challans</h2>
      <div className="table-scroll"><table aria-label="Challans for this order">
        <thead><tr><th>Challan</th><th>Driver</th><th>Vehicle</th><th>Status</th></tr></thead>
        <tbody>{data.challans.map((challan) => <tr key={challan.id}>
          <td><Link className="text-button" to={`/delivery-challans/${challan.id}`}>{challan.number}</Link></td>
          <td>{challan.driverName}</td><td>{challan.vehicleNo}</td><td>{challanStatusLabels[challan.status]}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
