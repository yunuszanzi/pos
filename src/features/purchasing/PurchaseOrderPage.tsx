import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { poStatusLabels } from "../../../shared/purchasing";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { cancelPurchaseOrder, closePurchaseOrder, getPurchaseOrderById, sendPurchaseOrder, type PurchaseOrder } from "../../api/purchasingApi";
import { ErrorMessage, PageTitle, SelectInput, SuccessMessage } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { dayText, momentDayText } from "./dayText";
import { usePrintSetup } from "./usePrintSetup";

type Move = "send" | "cancel" | "close";
const moves: Record<Move, { label: string; done: string; run: typeof sendPurchaseOrder }> = {
  send: { label: "Send to supplier", done: "marked as sent", run: sendPurchaseOrder },
  cancel: { label: "Cancel order", done: "cancelled", run: cancelPurchaseOrder },
  close: { label: "Close order", done: "closed", run: closePurchaseOrder },
};

/** One purchase order: what was asked for, what has come, and what can be done with it next. */
export function PurchaseOrderPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayOrder = useCan("purchasing.order");
  const mayReceive = useCan("purchasing.receive");
  const setup = usePrintSetup();
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per kind of move on this order, so pressing twice cannot do it twice.
  const keys = useRef(new Map<Move, string>());
  const order = useQuery({ queryKey: ["purchase-order", id], queryFn: () => getPurchaseOrderById(id), staleTime: 0 });

  if (order.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (order.isError) return <div className="content"><ErrorMessage>{order.error.message}</ErrorMessage></div>;
  const data: PurchaseOrder = order.data;
  const showCost = data.totalPaisa !== undefined;
  const canMove = (move: Move) => mayOrder && ((move === "send" && data.status === "draft")
    || (move === "cancel" && (data.status === "draft" || data.status === "sent"))
    || (move === "close" && (data.status === "partly_received" || data.status === "received")));

  async function move(action: Move) {
    setBusy(true);
    setError("");
    setNotice("");
    if (!keys.current.has(action)) keys.current.set(action, `po-${action}-${crypto.randomUUID()}`);
    try {
      await moves[action].run(id, keys.current.get(action)!);
      setNotice(`${data.number} ${moves[action].done}.`);
      await Promise.all(["purchase-order", "purchase-orders"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
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
      purchaseOrder: {
        number: data.number, orderDate: data.orderDate, expectedDate: data.expectedDate, supplierName: data.supplierName, branchName: data.branchName, locationName: data.locationName, note: data.note,
        ...(data.totalPaisa !== undefined ? { totalPaisa: data.totalPaisa } : {}),
        lines: data.lines.map((line) => ({
          productName: line.productName, variantName: line.variantName, sku: line.sku, unitName: line.unitName, quantity: line.quantity,
          ...(line.unitCostPaisa !== undefined ? { unitCostPaisa: line.unitCostPaisa, lineTotalPaisa: line.lineTotalPaisa } : {}),
        })),
      },
    });
  }

  return <div className="content">
    <PageTitle title={`${data.number} — ${poStatusLabels[data.status]}`} description={`To ${data.supplierName}, to be received into ${data.locationName}.`} />
    <p><Link className="text-button" to="/purchase-orders">← Back to purchase orders</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Supplier</dt><dd>{data.supplierName}</dd></div>
        <div><dt>Ordered on</dt><dd>{dayText(data.orderDate)}</dd></div>
        {data.expectedDate && <div><dt>Expected on</dt><dd>{dayText(data.expectedDate)}</dd></div>}
        {showCost && <div className="grand"><dt>Order total</dt><dd data-testid="order-total">{formatPkr(data.totalPaisa!)}</dd></div>}
      </dl>
      {data.note && <p className="muted">{data.note}</p>}
      <div className="button-row">
        {mayOrder && data.status === "draft" && <Link className="button secondary" to={`/purchase-orders/${data.id}/edit`}>Change order</Link>}
        {canMove("send") && <button className="button primary" disabled={busy} onClick={() => void move("send")}>{moves.send.label}</button>}
        {mayReceive && (data.status === "sent" || data.status === "partly_received") && <Link className="button primary" to={`/goods-receipts/new?order=${data.id}`}>Receive goods</Link>}
        {canMove("close") && <button className="button secondary" disabled={busy} onClick={() => void move("close")}>{moves.close.label}</button>}
        {canMove("cancel") && <button className="button secondary" disabled={busy} onClick={() => void move("cancel")}>{moves.cancel.label}</button>}
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
        <thead><tr><th>Item</th><th>Unit</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Still to come</th>{showCost && <><th className="num">Price</th><th className="num">Total</th></>}</tr></thead>
        <tbody>
          {data.lines.map((line) => <tr key={line.id}>
            <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
            <td>{line.unitName}</td><td className="num">{line.quantity}</td>
            <td className="num">{line.receivedBase}</td><td className="num">{line.remainingQuantity}</td>
            {showCost && <><td className="num">{formatPkr(line.unitCostPaisa ?? 0)}</td><td className="num">{formatPkr(line.lineTotalPaisa ?? 0)}</td></>}
          </tr>)}
        </tbody>
      </table></div>
      <p className="muted">"Received" counts in pieces (the base unit); "Still to come" is in the unit ordered.</p>
    </section>

    <section className="panel stack">
      <h2>Goods received</h2>
      <div className="table-scroll"><table aria-label="Receipts for this order">
        <thead><tr><th>Receipt</th><th>Date</th><th>Supplier's reference</th>{showCost && <th className="num">Value</th>}</tr></thead>
        <tbody>
          {data.receipts.map((receipt) => <tr key={receipt.id}>
            <td><Link className="text-button" to={`/goods-receipts/${receipt.id}`}>{receipt.number}</Link></td>
            <td>{momentDayText(receipt.receivedAt)}</td><td>{receipt.supplierRef}</td>
            {showCost && <td className="num">{formatPkr(receipt.totalPaisa ?? 0)}</td>}
          </tr>)}
          {data.receipts.length === 0 && <tr><td colSpan={showCost ? 4 : 3} className="muted">Nothing received yet.</td></tr>}
        </tbody>
      </table></div>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
