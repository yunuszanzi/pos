import { useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatPkr, toPlainRupees } from "../../shared/money";
import { closeShift, getShiftReport, openShift, recordCashMovement, type ShiftReport } from "../api/posApi";
import { ErrorMessage, Field, SelectInput, TextInput } from "../app/FormElements";
import { MoneyInput } from "../app/MoneyInput";
import { amountOf } from "./amounts";
import { Dialog } from "./Dialog";
import { usePos } from "./pos-context";

const messageOf = (caught: unknown, fallback: string) => (caught instanceof Error ? caught.message : fallback);

/** Shown instead of the till until a shift is open on this terminal (FR-CSH-01). */
export function OpenShiftForm() {
  const { setShift, data } = usePos();
  const [float, setFloat] = useState("0.00");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(`shift-open-${crypto.randomUUID()}`);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const openingFloatPaisa = amountOf(float);
    if (openingFloatPaisa === null) return setError("Enter the opening cash as rupees, for example 5000.00");
    setError("");
    setBusy(true);
    try {
      setShift(await openShift(openingFloatPaisa, key.current));
    } catch (caught) {
      setError(messageOf(caught, "The shift could not be opened"));
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page"><form className="auth-card stack" onSubmit={submit}>
    <div><p className="eyebrow">{data.terminal.name} · {data.branch.name}</p><h1>Open a shift</h1><p className="muted">Count the cash in the drawer and enter it to start selling.</p></div>
    <Field label="Opening cash (Rs)"><MoneyInput value={float} onChange={(event) => setFloat(event.target.value)} autoFocus required /></Field>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <button className="button primary" disabled={busy}>{busy ? "Opening…" : "Open shift"}</button>
  </form></main>;
}

export function CashMovementDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const { shift } = usePos();
  const [kind, setKind] = useState<"cash_in" | "cash_out">("cash_out");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(`cash-${crypto.randomUUID()}`);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amountPaisa = amountOf(amount);
    if (!amountPaisa) return setError("Enter an amount more than zero");
    if (!reason.trim()) return setError("Give a reason");
    setBusy(true);
    setError("");
    try {
      await recordCashMovement(shift!.id, { kind, amountPaisa, reason: reason.trim() }, key.current);
      onDone(`${kind === "cash_in" ? "Cash in" : "Cash out"} of ${formatPkr(amountPaisa)} recorded`);
    } catch (caught) {
      setError(messageOf(caught, "Could not record the cash movement"));
      setBusy(false);
    }
  }

  return <Dialog title="Cash in / out" onClose={onClose}><form className="stack" onSubmit={submit}>
    <Field label="Type"><SelectInput value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
      <option value="cash_out">Cash out (paid from the drawer)</option><option value="cash_in">Cash in (added to the drawer)</option>
    </SelectInput></Field>
    <Field label="Amount (Rs)"><MoneyInput value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus required /></Field>
    <Field label="Reason"><TextInput value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} required /></Field>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <button className="button primary" disabled={busy}>Record</button>
  </form></Dialog>;
}

function ReportLines({ report }: { report: ShiftReport }) {
  return <table className="report-table"><tbody>
    <tr><td>Sales</td><td>{report.invoiceCount} bills</td><td className="num">{formatPkr(report.totalPaisa)}</td></tr>
    {report.byMethod.map((method) => <tr key={method.code}><td>{method.name}</td><td>{method.payments} payments</td><td className="num">{formatPkr(method.amountPaisa)}</td></tr>)}
    {report.creditSalesPaisa > 0 && <tr><td>Sold on credit</td><td>to khata</td><td className="num">{formatPkr(report.creditSalesPaisa)}</td></tr>}
    {report.customerPaymentsPaisa > 0 && <tr><td>Received from customers</td><td>{formatPkr(report.customerPaymentsCashPaisa)} cash</td><td className="num">{formatPkr(report.customerPaymentsPaisa)}</td></tr>}
    {report.supplierPaymentsPaisa > 0 && <tr><td>Paid to suppliers</td><td>{formatPkr(report.supplierPaymentsCashPaisa)} cash</td><td className="num">{formatPkr(report.supplierPaymentsPaisa)}</td></tr>}
    <tr><td>Cash in</td><td /><td className="num">{formatPkr(report.cashInPaisa)}</td></tr>
    <tr><td>Cash out</td><td /><td className="num">{formatPkr(report.cashOutPaisa)}</td></tr>
    <tr><td>Tax in sales</td><td /><td className="num">{formatPkr(report.taxPaisa)}</td></tr>
    <tr><td>Discounts given</td><td /><td className="num">{formatPkr(report.discountPaisa)}</td></tr>
  </tbody></table>;
}

/** Counting the drawer comes first; the expected cash and the variance appear only after the count is in (blind count, FR-CSH-03). */
export function CloseShiftDialog({ onClose, onClosed }: { onClose: () => void; onClosed: () => void }) {
  const { shift, setShift, can } = usePos();
  const report = useQuery({ queryKey: ["shift-report", shift?.id], queryFn: () => getShiftReport(shift!.id), enabled: Boolean(shift), staleTime: 0 });
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof closeShift>> | null>(null);
  const key = useRef(`shift-close-${crypto.randomUUID()}`);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const countedPaisa = amountOf(counted);
    if (countedPaisa === null) return setError("Enter the counted cash as rupees, for example 48250.00");
    setBusy(true);
    setError("");
    try {
      // The till stays up behind the Z report; the shift is released when the report is dismissed.
      setResult(await closeShift(shift!.id, { countedPaisa, note: note.trim() }, key.current));
    } catch (caught) {
      setError(messageOf(caught, "The shift could not be closed"));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    setShift(null);
    onClosed();
  }

  if (result) {
    const variance = result.shift.variancePaisa ?? 0;
    return <Dialog title="Shift closed (Z report)" onClose={finish} wide><div className="stack">
      <ReportLines report={result.report} />
      <table className="report-table"><tbody>
        <tr><td>Expected cash</td><td className="num">{formatPkr(result.shift.expectedPaisa ?? 0)}</td></tr>
        <tr><td>Counted cash</td><td className="num">{formatPkr(result.shift.countedPaisa ?? 0)}</td></tr>
        <tr className={variance === 0 ? "" : "variance"}><td>Variance</td><td className="num" data-testid="variance">{variance > 0 ? "+" : ""}{formatPkr(variance)}</td></tr>
      </tbody></table>
      <button className="button primary" onClick={finish} autoFocus>Done</button>
    </div></Dialog>;
  }

  return <Dialog title="Close shift" onClose={onClose} wide><form className="stack" onSubmit={submit}>
    {report.data && <>
      <p className="muted">Sales so far (X report)</p>
      <ReportLines report={report.data.report} />
      {can("shifts.view_all") && report.data.report.expectedCashPaisa !== undefined && <p>Expected cash: <strong>{formatPkr(report.data.report.expectedCashPaisa)}</strong></p>}
    </>}
    {report.isError && <ErrorMessage>{report.error.message}</ErrorMessage>}
    <Field label="Cash counted in the drawer (Rs)"><MoneyInput value={counted} onChange={(event) => setCounted(event.target.value)} autoFocus required placeholder={toPlainRupees(0)} /></Field>
    <Field label="Note (optional)"><TextInput value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></Field>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <button className="button primary" disabled={busy || report.isPending}>{busy ? "Closing…" : "Close shift"}</button>
  </form></Dialog>;
}
