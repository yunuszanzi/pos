import { useState } from "react";
import { formatPkr } from "../../shared/money";
import { Dialog } from "./Dialog";
import { usePos } from "./pos-context";

/** What the till says about its connection: that it can keep selling, what is waiting to be sent, and what needs a person. */
export function OfflineBar() {
  const { offline } = usePos();
  const [open, setOpen] = useState(false);
  const waiting = offline.queued.length;
  const refused = offline.refused.length;
  if (offline.online && !waiting && !refused && !offline.lastSent) return null;
  return <div className="offline-bar" role="status" data-testid="offline-bar">
    {!offline.online && <strong data-testid="offline-state">No connection. You can keep selling: sales are kept on this till and sent when the connection returns.</strong>}
    {offline.online && waiting > 0 && <strong data-testid="offline-state">Sending {waiting} {waiting === 1 ? "sale" : "sales"} made without a connection…</strong>}
    {!offline.online && waiting > 0 && <span data-testid="offline-waiting">{waiting} {waiting === 1 ? "sale" : "sales"} waiting to be sent</span>}
    {offline.online && !waiting && offline.lastSent && <span data-testid="offline-sent">Sent {offline.lastSent.count} {offline.lastSent.count === 1 ? "sale" : "sales"} made without a connection: {offline.lastSent.numbers.slice(0, 3).join(", ")}{offline.lastSent.numbers.length > 3 ? ` and ${offline.lastSent.numbers.length - 3} more` : ""}.</span>}
    {refused > 0 && <span className="short" data-testid="offline-refused">{refused} {refused === 1 ? "sale was" : "sales were"} refused and need attention.</span>}
    {(waiting > 0 || refused > 0) && <button className="text-button" onClick={() => setOpen(true)}>See them</button>}
    {open && <OfflineSalesDialog onClose={() => setOpen(false)} />}
  </div>;
}

function OfflineSalesDialog({ onClose }: { onClose: () => void }) {
  const { offline } = usePos();
  const all = [...offline.queued, ...offline.refused].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return <Dialog title="Sales made without a connection" onClose={onClose}>
    <div className="stack">
      <p className="muted">These are kept on this till and sent in the order they were made. Do not sign out of this device until they are sent.</p>
      <table aria-label="Offline sales">
        <thead><tr><th>Slip</th><th>Made</th><th className="num">Total</th><th>Status</th></tr></thead>
        <tbody>{all.map((sale) => <tr key={sale.seq}>
          <td className="mono">{sale.offlineRef}</td>
          <td>{new Date(sale.soldAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
          <td className="num">{formatPkr(sale.invoice.totalPaisa)}</td>
          <td>{sale.status === "failed"
            ? <><span className="short">Refused: {sale.lastError}</span> <button className="text-button" onClick={() => void offline.retry(sale.seq!)}>Try again</button></>
            : sale.attempts > 0 ? "Waiting; last try failed" : "Waiting to be sent"}</td>
        </tr>)}</tbody>
      </table>
      <div className="button-row">
        <button className="button secondary" disabled={!offline.online || !offline.queued.length} onClick={() => void offline.sendNow()}>Send now</button>
        <button className="button primary" onClick={onClose}>Close</button>
      </div>
    </div>
  </Dialog>;
}
