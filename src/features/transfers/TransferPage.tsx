import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { transferStatusLabels } from "../../../shared/schemas/transfers";
import { cancelStockTransfer, dispatchStockTransfer, getStockTransferById, receiveStockTransfer } from "../../api/transfersApi";
import { ErrorMessage, Field, PageTitle, SuccessMessage, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";
import { useCan } from "../../app/permissions";

const when = (value: string | null) => (value ? new Date(value).toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }) : "—");

/** One transfer: what was sent, and the buttons that move it on. */
export function TransferPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayManage = useCan("transfers.manage");
  const detail = useQuery({ queryKey: ["stock-transfer", id], queryFn: () => getStockTransferById(id) });
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [arrived, setArrived] = useState<Record<string, string>>({});
  const [receiveNote, setReceiveNote] = useState("");
  // One key per action on this page: pressing twice does the thing once.
  const keys = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (keys.current[action] ??= crypto.randomUUID());
  const row = detail.data;

  async function run(action: "dispatch" | "receive" | "cancel", message: string) {
    if (!row) return;
    setBusy(true); setError(""); setDone("");
    try {
      if (action === "dispatch") await dispatchStockTransfer(id, keyFor(action));
      else if (action === "cancel") await cancelStockTransfer(id, keyFor(action));
      else {
        // Only the lines whose count was changed are sent; the rest arrived in full.
        const lines = row.lines.filter((line) => arrived[line.id] !== undefined && arrived[line.id].trim() !== "" && arrived[line.id].trim() !== line.quantity)
          .map((line) => ({ lineId: line.id, quantity: arrived[line.id].trim() }));
        await receiveStockTransfer(id, { note: receiveNote, lines }, keyFor(action));
      }
      keys.current = {};
      setDone(message);
      await Promise.all(["stock-transfer", "stock-transfers", "in-transit", "stock"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    } catch (caught) {
      // A refused action may be tried again with a fresh key once whatever was wrong is fixed.
      keys.current = {};
      setError(caught instanceof Error ? caught.message : "That did not work");
    } finally {
      setBusy(false);
    }
  }

  if (detail.isError) return <div className="content"><ErrorMessage>{detail.error.message}</ErrorMessage></div>;
  if (!row) return <div className="content"><p className="muted">Loading…</p></div>;
  const withCost = row.lines.some((line) => line.costPaisa !== undefined);
  const received = row.status === "received";
  return <div className="content">
    <PageTitle title={`${row.number} — ${transferStatusLabels[row.status]}`} description={`${row.fromName} to ${row.toName}${row.toType === "damaged" ? " (damaged goods)" : ""}`} />
    <p><Link className="text-button" to="/transfers">← Back to transfers</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {done && <SuccessMessage>{done}</SuccessMessage>}
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Status</dt><dd data-testid="transfer-status">{transferStatusLabels[row.status]}</dd></div>
        <div><dt>Written</dt><dd>{when(row.createdAt)}{row.createdByName ? ` by ${row.createdByName}` : ""}</dd></div>
        {row.dispatchedAt && <div><dt>Sent</dt><dd>{when(row.dispatchedAt)}{row.dispatchedByName ? ` by ${row.dispatchedByName}` : ""}</dd></div>}
        {row.receivedAt && <div><dt>Received</dt><dd>{when(row.receivedAt)}{row.receivedByName ? ` by ${row.receivedByName}` : ""}</dd></div>}
        {row.cancelledAt && <div><dt>Cancelled</dt><dd>{when(row.cancelledAt)}</dd></div>}
      </dl>
      {row.note && <p className="muted">{row.note}</p>}
      {row.receiveNote && <p className="muted">On receipt: {row.receiveNote}</p>}
      <div className="table-scroll"><table aria-label="Transfer items">
        <thead><tr><th>Item</th><th className="num">Sent</th>{(row.status === "dispatched" || received) && <th className="num">Arrived</th>}{received && <th className="num">Short</th>}{withCost && <th className="num">Cost each</th>}</tr></thead>
        <tbody>{row.lines.map((line) => <tr key={line.id}>
          <td>{line.productName} <span className="mono">{line.sku}</span></td>
          <td className="num">{line.quantity} {line.unitName}{line.factorToBase !== "1" && <small className="block muted">{line.qtyBase} in the base unit</small>}</td>
          {row.status === "dispatched" && <td className="num">{mayManage
            ? <QuantityInput aria-label={`Arrived ${line.sku}`} value={arrived[line.id] ?? line.quantity} onChange={(event) => setArrived({ ...arrived, [line.id]: event.target.value })} />
            : "—"}</td>}
          {received && <td className="num">{line.receivedBase}</td>}
          {received && <td className="num" data-testid={`short-${line.sku}`}>{line.shortageBase}</td>}
          {withCost && <td className="num">{formatPkr(line.costPaisa ?? 0)}</td>}
        </tr>)}</tbody>
      </table></div>
      {mayManage && row.status === "dispatched" && <Field label="Note on receipt (optional)"><TextInput value={receiveNote} maxLength={1000} onChange={(event) => setReceiveNote(event.target.value)} placeholder="Anything wrong with the delivery?" /></Field>}
      {mayManage && <div className="button-row">
        {row.status === "requested" && <button className="button primary" disabled={busy} onClick={() => void run("dispatch", "Sent. The stock has left the source and is in transit.")}>Send (stock leaves {row.fromName})</button>}
        {row.status === "requested" && <button className="button secondary" disabled={busy} onClick={() => void run("cancel", "Transfer cancelled.")}>Cancel transfer</button>}
        {row.status === "dispatched" && <button className="button primary" disabled={busy} onClick={() => void run("receive", "Received into the destination.")}>Receive into {row.toName}</button>}
      </div>}
    </section>
  </div>;
}
