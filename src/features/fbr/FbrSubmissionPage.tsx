import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { getFbrSubmissionById, resubmitToFbr } from "../../api/fbrApi";
import { ErrorMessage, PageTitle, SuccessMessage } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { statusText, timeText } from "./FbrLogPage";

const stepText = { local: "Our own checks", validate: "FBR check", post: "Report to FBR" } as const;

/** One document's trip to FBR: what was sent, what came back, and every try. */
export function FbrSubmissionPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayResubmit = useCan("fbr.resubmit");
  const key = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const detail = useQuery({ queryKey: ["fbr-submission", id], queryFn: () => getFbrSubmissionById(id) });
  const row = detail.data;

  async function retry() {
    setBusy(true); setError(""); setDone("");
    try {
      const result = await resubmitToFbr(id, key.current);
      key.current = crypto.randomUUID();
      setDone(result.message || statusText(result.status));
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["fbr-submission", id] }), queryClient.invalidateQueries({ queryKey: ["fbr-submissions"] }), queryClient.invalidateQueries({ queryKey: ["fbr-summary"] })]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send it again");
    } finally {
      setBusy(false);
    }
  }

  if (detail.isError) return <div className="content"><ErrorMessage>{detail.error.message}</ErrorMessage></div>;
  if (!row) return <div className="content"><p className="muted">Loading…</p></div>;
  return <div className="content">
    <PageTitle title={`FBR: ${row.number}`} description={row.docType === "sales_return" ? "A return, reported to FBR as a debit note." : "A sale invoice reported to FBR."} />
    <section className="panel stack">
      <dl className="totals">
        <div><dt>Status</dt><dd data-testid="fbr-status">{statusText(row.status)}</dd></div>
        <div><dt>FBR invoice no.</dt><dd>{row.irn ?? "—"}</dd></div>
        {row.refIrn && <div><dt>Against FBR invoice</dt><dd>{row.refIrn}</dd></div>}
        <div><dt>Environment</dt><dd>{row.environment === "production" ? "Live" : "Sandbox"}</dd></div>
        <div><dt>Tries</dt><dd>{row.attempts.length}</dd></div>
        <div><dt>Accepted at</dt><dd>{timeText(row.acceptedAt)}</dd></div>
        {row.status === "pending" && <div><dt>Next try</dt><dd>{timeText(row.nextRetryAt)}</dd></div>}
      </dl>
      {row.errorMessage && row.status !== "accepted" && <ErrorMessage>{row.errorCode ? `${row.errorCode}: ` : ""}{row.errorMessage}</ErrorMessage>}
      {done && <SuccessMessage>{done}</SuccessMessage>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="button-row">
        {mayResubmit && row.status !== "accepted" && <button className="button primary" disabled={busy} onClick={() => void retry()}>{busy ? "Sending…" : "Send to FBR again"}</button>}
        <Link className="button secondary" to={row.docType === "sales_return" ? "/returns" : `/invoices/${row.docId}`}>Open the document</Link>
        <Link className="button secondary" to="/fbr/log">Back to the log</Link>
      </div>
    </section>
    <section className="panel stack">
      <h2>Tries</h2>
      {row.attempts.length === 0 && <p className="muted">Nothing has been sent yet.</p>}
      {row.attempts.map((attempt) => <details key={attempt.id}>
        <summary>#{attempt.attemptNo} · {stepText[attempt.step]} · {attempt.outcome}{attempt.httpStatus ? ` (${attempt.httpStatus})` : ""} · {timeText(attempt.createdAt)}</summary>
        <p>{attempt.message}</p>
        <p className="muted">What was sent</p><pre className="code-block">{JSON.stringify(attempt.request, null, 2)}</pre>
        <p className="muted">What FBR answered</p><pre className="code-block">{JSON.stringify(attempt.response, null, 2)}</pre>
      </details>)}
    </section>
  </div>;
}
