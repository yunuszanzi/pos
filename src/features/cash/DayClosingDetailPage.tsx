import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { getDayClosingById, reopenDayClosing } from "../../api/dayClosingApi";
import { ErrorMessage, Field, PageTitle, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText, momentDayText } from "../purchasing/dayText";
import { DaySummaryView } from "./DaySummaryView";

/** One closed day as it was written down, for printing, and the one correction allowed: reopening it. */
export function DayClosingDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayClose = useCan("cash.close_day");
  const found = useQuery({ queryKey: ["day-closing", id], queryFn: () => getDayClosingById(id), staleTime: 0 });
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(`cls-reopen-${crypto.randomUUID()}`);

  if (found.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (found.isError) return <div className="content"><ErrorMessage>{found.error.message}</ErrorMessage></div>;
  const data = found.data;

  async function reopen() {
    setBusy(true);
    setError("");
    try {
      await reopenDayClosing(id, reason.trim(), key.current);
      setReopening(false);
      setNotice(`${data.number} was reopened. Shifts and expenses can be recorded for ${dayText(data.businessDate)} again; close the day again when done.`);
      await Promise.all(["day-closing", "day-closings", "day-preview"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reopen the day");
      key.current = `cls-reopen-${crypto.randomUUID()}`;
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title={`${data.number}${data.reopened ? " — Reopened" : ""}`} description={`${data.branchName}, ${dayText(data.businessDate)}. Closed ${momentDayText(data.closedAt)}${data.closedByName ? ` by ${data.closedByName}` : ""}.`} />
    <p className="no-print"><Link className="text-button" to="/day-closings">← Back to day-end closing</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    {data.reopened && <ErrorMessage>Reopened {momentDayText(data.reopenedAt)}{data.reopenedByName ? ` by ${data.reopenedByName}` : ""}: {data.reopenReason}. This record is kept; the figures below are what it said when it was closed.</ErrorMessage>}
    {data.note && <p className="muted">{data.note}</p>}
    <DaySummaryView summary={data.summary} />
    <section className="panel stack no-print">
      <div className="button-row"><button className="button secondary" onClick={() => window.print()}>Print or save as PDF</button></div>
      {mayClose && !data.reopened && (reopening
        ? <div className="stack">
          <Field label="Why is the day being reopened?"><TextInput value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} /></Field>
          <div className="button-row">
            <button className="button primary" disabled={busy || !reason.trim()} onClick={() => void reopen()}>Reopen the day</button>
            <button className="button secondary" disabled={busy} onClick={() => setReopening(false)}>Not now</button>
          </div>
        </div>
        : <div className="button-row"><button className="button secondary" onClick={() => setReopening(true)}>Reopen this day</button></div>)}
    </section>
  </div>;
}
