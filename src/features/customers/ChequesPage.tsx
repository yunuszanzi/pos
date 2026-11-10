import { useEffect, useRef, useState, type FormEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { chequeStatusLabels, type ChequeStatus } from "../../../shared/schemas/cheques";
import { bounceCheque, clearCheque, depositCheque, getAllCheques, type Cheque } from "../../api/customersApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { Dialog } from "../../pos/Dialog";
import { ReceiveChequeDialog } from "./ReceiveChequeDialog";

const pageSize = 25;
type View = ChequeStatus | "due" | "all";
const viewLabels: Record<View, string> = { due: "Due now", received: "In hand", deposited: "Deposited", cleared: "Cleared", bounced: "Bounced", all: "All" };

/** Asks why a cheque bounced. The reason is kept on the cheque. */
function BounceDialog({ cheque, onClose, onBounce }: { cheque: Cheque; onClose: () => void; onBounce: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onBounce(reason);
    setBusy(false);
  }
  return <Dialog title="Cheque bounced" onClose={onClose}>
    <form className="stack" onSubmit={submit}>
      <p>{cheque.bank} cheque {cheque.chequeNo} for {formatPkr(cheque.amountPaisa)} from {cheque.customerName}. {formatPkr(cheque.amountPaisa)} goes back on their khata and the invoices it settled are open again.</p>
      <Field label="Why did it bounce?"><TextInput value={reason} maxLength={300} autoFocus placeholder="For example: insufficient funds" onChange={(event) => setReason(event.target.value)} /></Field>
      <button className="button primary" disabled={busy || !reason.trim()}>{busy ? "Saving…" : "Mark as bounced"}</button>
    </form>
  </Dialog>;
}

/** Cheques taken from customers, from in hand to cleared or bounced. Post-dated cheques show as due once the date written on them comes. */
export function ChequesPage() {
  const queryClient = useQueryClient();
  const mayReceive = useCan("customers.receive_payment");
  const mayHandle = useCan("customers.cheques");
  const [view, setView] = useState<View>("received");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [recording, setRecording] = useState(false);
  const [bouncing, setBouncing] = useState<Cheque | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // One key per attempt at one action on one cheque, so pressing twice cannot do it twice.
  const keys = useRef(new Map<string, string>());
  const keyFor = (id: string, action: string) => {
    const name = `${id}:${action}`;
    if (!keys.current.has(name)) keys.current.set(name, `cheque-${action}-${crypto.randomUUID()}`);
    return keys.current.get(name)!;
  };

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({
    queryKey: ["cheques", { view, search, page }],
    queryFn: ({ signal }) => getAllCheques({ status: view === "due" || view === "all" ? "" : view, due: view === "due", q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function move(cheque: Cheque, action: "deposit" | "clear" | "bounce", reason = "") {
    setBusy(cheque.id);
    setError("");
    setNotice("");
    try {
      if (action === "deposit") await depositCheque(cheque.id, keyFor(cheque.id, action));
      else if (action === "clear") await clearCheque(cheque.id, keyFor(cheque.id, action));
      else await bounceCheque(cheque.id, reason, keyFor(cheque.id, action));
      setNotice(action === "bounce"
        ? `Cheque ${cheque.chequeNo} bounced. ${formatPkr(cheque.amountPaisa)} is back on ${cheque.customerName}'s khata.`
        : `Cheque ${cheque.chequeNo} ${action === "deposit" ? "deposited" : "cleared"}.`);
      setBouncing(null);
      await Promise.all(["cheques", "customers", "customer-ledger", "customer-ageing", "customer-statement"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the cheque");
    } finally {
      setBusy("");
    }
  }

  return <div className="content">
    <PageTitle title="Cheques" description="A cheque counts as money received the day you take it, even if it is post-dated. If it bounces, the amount goes back on the customer's khata." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <div className="form-grid">
        <SelectInput aria-label="Show" value={view} onChange={(event) => { setView(event.target.value as View); setPage(1); }}>
          {(Object.keys(viewLabels) as View[]).map((value) => <option key={value} value={value}>{viewLabels[value]}</option>)}
        </SelectInput>
        <TextInput aria-label="Search cheques" placeholder="Cheque number, bank or customer" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {mayReceive && <div className="button-row"><button className="button primary" onClick={() => setRecording(true)}>Receive a cheque</button></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Cheques">
        <thead><tr><th>Customer</th><th>Cheque</th><th>Bank</th><th>Date on cheque</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((cheque) => <tr key={cheque.id}>
            <td><Link className="text-button" to={`/customers/${cheque.customerId}/ledger`}>{cheque.customerName}</Link></td>
            <td>{cheque.chequeNo}</td><td>{cheque.bank}</td><td>{cheque.chequeDate}</td>
            <td className="num">{formatPkr(cheque.amountPaisa)}</td>
            <td>{chequeStatusLabels[cheque.status]}{cheque.due && <span className="status">Due</span>}{cheque.status === "bounced" && cheque.bounceReason && <small className="block muted">{cheque.bounceReason}</small>}</td>
            <td className="action-cell">
              {mayHandle && cheque.status === "received" && <button className="text-button" disabled={Boolean(busy)} onClick={() => void move(cheque, "deposit")}>Deposited</button>}
              {mayHandle && cheque.status === "deposited" && <button className="text-button" disabled={Boolean(busy)} onClick={() => void move(cheque, "clear")}>Cleared</button>}
              {mayHandle && (cheque.status === "received" || cheque.status === "deposited") && <button className="text-button" disabled={Boolean(busy)} onClick={() => setBouncing(cheque)}>Bounced</button>}
            </td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={7} className="muted">{view === "due" ? "No cheque has reached its date." : "No cheques here."}</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "cheque" : "cheques"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
    {recording && <ReceiveChequeDialog onClose={() => setRecording(false)} />}
    {bouncing && <BounceDialog cheque={bouncing} onClose={() => setBouncing(null)} onBounce={(reason) => move(bouncing, "bounce", reason)} />}
  </div>;
}
