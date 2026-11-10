import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { challanStatusLabels } from "../../../shared/schemas/deliveryChallans";
import { dispatchDeliveryChallan, getDeliveryChallanById, moveDeliveryChallan, returnDeliveryChallan, type Challan } from "../../api/deliveryApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { challanPrintDoc } from "../../pos/documentPrint";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { momentDayText } from "../purchasing/dayText";
import { ShareLinkButton } from "../sharing/ShareLinkButton";
import { usePrintSetup } from "../purchasing/usePrintSetup";

type Action = "dispatch" | "deliver" | "cancel" | "return";

/** One delivery challan: what is on the trip, who takes it, and the steps from pending to delivered (or back). */
export function DeliveryChallanPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayManage = useCan("delivery.manage");
  const setup = usePrintSetup();
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [driverName, setDriverName] = useState<string | null>(null);
  const [vehicleNo, setVehicleNo] = useState<string | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [returning, setReturning] = useState(false);
  // One key per kind of step on this challan, so pressing twice cannot do it twice.
  const keys = useRef(new Map<Action, string>());
  const found = useQuery({ queryKey: ["delivery-challan", id], queryFn: () => getDeliveryChallanById(id), staleTime: 0 });

  if (found.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (found.isError) return <div className="content"><ErrorMessage>{found.error.message}</ErrorMessage></div>;
  const data: Challan = found.data;

  async function run(action: Action, work: (key: string) => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    if (!keys.current.has(action)) keys.current.set(action, `dc-${action}-${crypto.randomUUID()}`);
    try {
      await work(keys.current.get(action)!);
      setNotice(`${data.number} ${done}.`);
      // Stock and the order moved, so those lists must be asked again.
      await Promise.all(["delivery-challan", "delivery-challans", "sales-order", "sales-orders", "stock"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the challan");
    } finally {
      setBusy(false);
    }
  }

  function print() {
    if (!setup) return;
    setJob({
      business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat,
      deliveryChallan: challanPrintDoc(data),
    });
  }

  return <div className="content">
    <PageTitle title={`${data.number} — ${challanStatusLabels[data.status]}`} description={`For ${data.customerName}, from ${data.locationName}, against order ${data.orderNumber}.`} />
    <p><Link className="text-button" to="/delivery-challans">← Back to delivery challans</Link> · <Link className="text-button" to={`/sales-orders/${data.orderId}`}>Open order {data.orderNumber}</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Customer</dt><dd>{data.customerName}{data.customerPhone ? ` · ${data.customerPhone}` : ""}</dd></div>
        {data.deliveryAddress && <div><dt>Deliver to</dt><dd>{data.deliveryAddress}</dd></div>}
        <div><dt>Driver</dt><dd>{data.driverName || "—"}</dd></div>
        <div><dt>Vehicle</dt><dd>{data.vehicleNo || "—"}</dd></div>
        <div><dt>Route</dt><dd>{data.route || "—"}</dd></div>
        {data.dispatchedAt && <div><dt>Dispatched</dt><dd>{momentDayText(data.dispatchedAt)}</dd></div>}
        {data.deliveredAt && <div><dt>Delivered</dt><dd>{momentDayText(data.deliveredAt)}</dd></div>}
        {data.returnedAt && <div><dt>Came back</dt><dd>{momentDayText(data.returnedAt)}: {data.returnReason}</dd></div>}
      </dl>
      {data.note && <p className="muted">{data.note}</p>}

      {mayManage && data.status === "pending" && <div className="stack">
        <div className="form-grid">
          <Field label="Driver"><TextInput value={driverName ?? data.driverName} maxLength={100} onChange={(event) => setDriverName(event.target.value)} /></Field>
          <Field label="Vehicle number"><TextInput value={vehicleNo ?? data.vehicleNo} maxLength={30} onChange={(event) => setVehicleNo(event.target.value)} /></Field>
          <Field label="Route"><TextInput value={route ?? data.route} maxLength={200} onChange={(event) => setRoute(event.target.value)} /></Field>
        </div>
        <div className="button-row">
          <button className="button primary" disabled={busy} onClick={() => void run("dispatch", (key) => dispatchDeliveryChallan(id, { driverName: driverName ?? undefined, vehicleNo: vehicleNo ?? undefined, route: route ?? undefined }, key), "dispatched; the stock has left")}>Dispatch (stock leaves)</button>
          <button className="button secondary" disabled={busy} onClick={() => void run("cancel", (key) => moveDeliveryChallan(id, "cancel", key), "cancelled")}>Cancel challan</button>
        </div>
      </div>}
      {mayManage && data.status === "dispatched" && <div className="button-row">
        <button className="button primary" disabled={busy} onClick={() => void run("deliver", (key) => moveDeliveryChallan(id, "deliver", key), "marked as delivered")}>Customer received it</button>
      </div>}
      {mayManage && (data.status === "dispatched" || data.status === "delivered") && (returning
        ? <div className="stack">
          <Field label="Why did the goods come back?"><TextInput value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></Field>
          <div className="button-row">
            <button className="button primary" disabled={busy || !reason.trim()} onClick={() => void run("return", (key) => returnDeliveryChallan(id, reason.trim(), key), "marked as returned; the goods are back in stock")}>Goods came back</button>
            <button className="button secondary" disabled={busy} onClick={() => setReturning(false)}>Not now</button>
          </div>
        </div>
        : <div className="button-row"><button className="button secondary" onClick={() => setReturning(true)}>Goods came back</button></div>)}

      <div className="button-row">
        <ShareLinkButton type="delivery_challan" id={data.id} phone={data.customerPhone} message={(url) => `Dear ${data.customerName}, delivery challan ${data.number} for order ${data.orderNumber}. ${url}`} />
      </div>

      {setup && <div className="pay-row">
        <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={print}>Print challan</button>
      </div>}
    </section>

    <section className="panel stack">
      <h2>Items on this trip</h2>
      <div className="table-scroll"><table aria-label="Challan items">
        <thead><tr><th>Item</th><th>Unit</th><th className="num">Quantity</th></tr></thead>
        <tbody>{data.lines.map((line) => <tr key={line.id}>
          <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
          <td>{line.unitName}</td><td className="num">{line.quantity}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
