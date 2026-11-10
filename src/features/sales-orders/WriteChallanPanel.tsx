import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { deliveryChallanSchema } from "../../../shared/schemas/deliveryChallans";
import { formatQuantity, parseQuantity } from "../../../shared/units";
import { postDeliveryChallan } from "../../api/deliveryApi";
import type { SalesOrder } from "../../api/salesOrdersApi";
import { ErrorMessage, Field, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";

/** What can still go on a new challan for an order line, in the unit it was ordered in (thousandths). */
const leftMilli = (line: SalesOrder["lines"][number]) => Math.floor((parseQuantity(line.unassignedBase) * 1000) / parseQuantity(line.factorToBase));

/** Writes a delivery challan for part or all of what an order has left to send. Nothing moves until it is dispatched. */
export function WriteChallanPanel({ order }: { order: SalesOrder }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(order.lines.map((line) => [line.id, formatQuantity(Math.max(0, leftMilli(line)))])));
  const [driverName, setDriverName] = useState("");
  const [vehicleNo, setVehicleNo] = useState("");
  const [route, setRoute] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(`dc-new-${crypto.randomUUID()}`);

  const left = order.lines.filter((line) => leftMilli(line) > 0);
  if (!left.length) return null;
  if (!open) return <div className="button-row"><button className="button primary" onClick={() => setOpen(true)}>Write a delivery challan</button></div>;

  async function submit() {
    setError("");
    const lines = left
      .map((line) => ({ orderLineId: line.id, quantity: (quantities[line.id] ?? "").trim() }))
      .filter((line) => line.quantity !== "" && parseQuantity(line.quantity) > 0);
    if (!lines.length) return setError("Enter how many of at least one item go on this trip");
    const input = { orderId: order.id, lines, driverName, vehicleNo, route };
    const checked = deliveryChallanSchema.safeParse(input);
    if (!checked.success) return setError(checked.error.issues[0].message);
    setBusy(true);
    try {
      const result = await postDeliveryChallan(input, key.current);
      await Promise.all(["delivery-challans", "sales-order"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/delivery-challans/${result.challan.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not write the challan");
      // A different attempt needs a different key, or the server would answer with the failed one.
      key.current = `dc-new-${crypto.randomUUID()}`;
      setBusy(false);
    }
  }

  return <section className="panel stack" aria-label="Write a delivery challan">
    <h2>Write a delivery challan</h2>
    <p className="muted">Choose what goes on this trip. The stock leaves when the challan is dispatched, not now.</p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <div className="table-scroll"><table aria-label="Quantities to send">
      <thead><tr><th>Item</th><th>Unit</th><th className="num">Still to send</th><th>Send now</th></tr></thead>
      <tbody>{left.map((line) => <tr key={line.id}>
        <td>{line.productName}{line.variantName ? ` — ${line.variantName}` : ""}<small className="block muted">{line.sku}</small></td>
        <td>{line.unitName}</td><td className="num">{formatQuantity(leftMilli(line))}</td>
        <td><QuantityInput aria-label={`Send now ${line.sku}`} value={quantities[line.id] ?? ""} onChange={(event) => setQuantities({ ...quantities, [line.id]: event.target.value })} /></td>
      </tr>)}</tbody>
    </table></div>
    <div className="form-grid">
      <Field label="Driver"><TextInput value={driverName} maxLength={100} onChange={(event) => setDriverName(event.target.value)} /></Field>
      <Field label="Vehicle number"><TextInput value={vehicleNo} maxLength={30} onChange={(event) => setVehicleNo(event.target.value)} /></Field>
      <Field label="Route"><TextInput value={route} maxLength={200} onChange={(event) => setRoute(event.target.value)} /></Field>
    </div>
    <div className="button-row">
      <button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Write challan"}</button>
      <button className="button secondary" disabled={busy} onClick={() => setOpen(false)}>Not now</button>
    </div>
  </section>;
}
