import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { attachExpenseBill, getExpenseBillLink, getExpenseById, reverseExpense } from "../../api/accountsApi";
import { getCurrentShift } from "../../api/posApi";
import { ErrorMessage, Field, PageTitle, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText, momentDayText } from "../purchasing/dayText";

/** One expense: what it was, the bill, and the one correction that is allowed: reversing it. */
export function ExpensePage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const mayCreate = useCan("expenses.create");
  const mayShift = useCan("shifts.open");
  const found = useQuery({ queryKey: ["expense", id], queryFn: () => getExpenseById(id), staleTime: 0 });
  const shift = useQuery({ queryKey: ["current-shift"], queryFn: getCurrentShift, enabled: mayShift });
  const [reason, setReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [billUrl, setBillUrl] = useState("");
  const [error, setError] = useState(params.get("bill") === "failed" ? `The expense was recorded, but the bill could not be saved${params.get("why") ? `: ${params.get("why")}` : ""}. Attach it again below.` : "");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const reverseKey = useRef(`exp-rev-${crypto.randomUUID()}`);

  if (found.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (found.isError) return <div className="content"><ErrorMessage>{found.error.message}</ErrorMessage></div>;
  const data = found.data;
  const openShift = shift.data?.status === "open" ? shift.data : null;

  async function refresh() {
    await Promise.all(["expense", "expenses", "accounts", "account-entries", "current-shift"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
  }

  async function showBill() {
    setBusy(true);
    setError("");
    try {
      const link = await getExpenseBillLink(id);
      setBillUrl(link.url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open the bill");
    } finally {
      setBusy(false);
    }
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await attachExpenseBill(id, file);
      setBillUrl("");
      setNotice("The bill was saved.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the bill");
    } finally {
      setBusy(false);
    }
  }

  async function reverse() {
    setBusy(true);
    setError("");
    try {
      await reverseExpense(id, { reason: reason.trim(), ...(data.paidFrom === "register" && openShift ? { shiftId: openShift.id } : {}) }, reverseKey.current);
      setReversing(false);
      setNotice(`${data.number} was reversed and the money put back.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reverse the expense");
      reverseKey.current = `exp-rev-${crypto.randomUUID()}`;
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title={`${data.number}${data.reversed ? " — Reversed" : ""}`} description={`${data.categoryName}, ${dayText(data.expenseDate)}.`} />
    <p><Link className="text-button" to="/expenses">← Back to expenses</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <dl className="totals">
        <div className="grand"><dt>Amount</dt><dd data-testid="expense-amount">{formatPkr(data.amountPaisa)}</dd></div>
        <div><dt>Paid from</dt><dd>{data.paidFrom === "register" ? "The register (cash drawer)" : data.accountName}</dd></div>
        {data.payee && <div><dt>Paid to</dt><dd>{data.payee}</dd></div>}
        {data.reference && <div><dt>Bill or cheque number</dt><dd>{data.reference}</dd></div>}
        <div><dt>Recorded</dt><dd>{momentDayText(data.createdAt)}{data.createdByName ? ` by ${data.createdByName}` : ""}</dd></div>
        {data.reversed && <div><dt>Reversed</dt><dd>{momentDayText(data.reversedAt)}: {data.reversalReason}</dd></div>}
      </dl>
      {data.note && <p className="muted">{data.note}</p>}
      <div className="stack">
        {data.hasAttachment
          ? <div className="button-row">
            {billUrl
              ? <a className="button primary" href={billUrl} target="_blank" rel="noreferrer">Open the bill ({data.attachmentName})</a>
              : <button className="button secondary" disabled={busy} onClick={() => void showBill()}>Show the bill</button>}
          </div>
          : <p className="muted">No bill attached.</p>}
        {mayCreate && !data.reversed && <Field label={data.hasAttachment ? "Replace the bill" : "Attach a photo or PDF of the bill"}>
          <input type="file" aria-label="Attach a bill" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy} onChange={(event) => void attach(event.target.files?.[0])} />
        </Field>}
      </div>
    </section>

    {mayCreate && !data.reversed && <section className="panel stack">
      <h2>Made a mistake?</h2>
      {!reversing
        ? <div className="button-row"><button className="button secondary" onClick={() => setReversing(true)}>Reverse this expense</button></div>
        : <div className="stack">
          <p className="muted">The expense stays on record, marked reversed, and the money goes back{data.paidFrom === "register" ? " into the open shift as cash in" : ` into ${data.accountName}`}. Then record the right one.</p>
          {data.paidFrom === "register" && !openShift && <ErrorMessage>Open a shift at the till first: the money goes back into the drawer.</ErrorMessage>}
          <Field label="Why is it being reversed?"><TextInput value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} /></Field>
          <div className="button-row">
            <button className="button primary" disabled={busy || !reason.trim() || (data.paidFrom === "register" && !openShift)} onClick={() => void reverse()}>Reverse expense</button>
            <button className="button secondary" disabled={busy} onClick={() => setReversing(false)}>Not now</button>
          </div>
        </div>}
    </section>}
  </div>;
}
