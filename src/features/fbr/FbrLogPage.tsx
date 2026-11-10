import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { fbrStatusLabels, type FbrStatus } from "../../../shared/fbr";
import { getAllFbrSubmissions, getFbrSummary, type FbrSubmissionFilter } from "../../api/fbrApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";

const pageSize = 25;
export const statusText = (status: FbrStatus) => fbrStatusLabels[status] ?? status;
export const timeText = (value: string | null) => (value ? new Date(value).toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }) : "—");

/** Every document that had to be reported to FBR, and where it stands. */
export function FbrLogPage() {
  const mayManage = useCan("fbr.manage");
  const [params] = useSearchParams();
  const [status, setStatus] = useState<FbrSubmissionFilter["status"]>(params.get("attention") ? "attention" : "");
  const [docType, setDocType] = useState<FbrSubmissionFilter["docType"]>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const summary = useQuery({ queryKey: ["fbr-summary"], queryFn: getFbrSummary, staleTime: 15_000 });
  const list = useQuery({
    queryKey: ["fbr-submissions", { status, docType, from, to, search, page }],
    queryFn: ({ signal }) => getAllFbrSubmissions({ status, docType, from, to, q: search, page }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const counts = summary.data;

  return <div className="content">
    <PageTitle title="FBR log" description="Every invoice and return that has to be reported to FBR, what FBR answered, and a way to send it again." />
    <section className="panel stack">
      {counts && <p data-testid="fbr-counts" className="muted">{counts.accepted} accepted · {counts.pending} waiting · {counts.rejected} refused by FBR · {counts.failed} given up</p>}
      <div className="form-grid">
        <Field label="Status">
          <SelectInput value={status} onChange={(event) => { setStatus(event.target.value as FbrSubmissionFilter["status"]); setPage(1); }}>
            <option value="">All</option>
            <option value="attention">Needs attention</option>
            <option value="pending">Waiting</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Refused by FBR</option>
            <option value="failed">Given up</option>
          </SelectInput>
        </Field>
        <Field label="Type">
          <SelectInput value={docType} onChange={(event) => { setDocType(event.target.value as FbrSubmissionFilter["docType"]); setPage(1); }}>
            <option value="">Invoices and returns</option>
            <option value="sales_invoice">Invoices</option>
            <option value="sales_return">Returns</option>
          </SelectInput>
        </Field>
        <Field label="From"><TextInput type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
        <Field label="To"><TextInput type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
        <Field label="Search"><TextInput aria-label="Search the FBR log" placeholder="Invoice number or FBR number" value={text} onChange={(event) => setText(event.target.value)} /></Field>
      </div>
      {mayManage && <div className="button-row"><Link className="button secondary" to="/settings/fbr">FBR settings</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="FBR log">
        <thead><tr><th>Document</th><th>Status</th><th>FBR invoice no.</th><th>Tries</th><th>Last try</th><th>Next try</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/fbr/log/${row.id}`}>{row.number}</Link><small className="block muted">{row.docType === "sales_return" ? "Return" : "Invoice"} · {row.environment === "production" ? "Live" : "Sandbox"}</small></td>
            <td>{statusText(row.status)}{row.errorMessage && row.status !== "accepted" && <small className="block muted">{row.errorMessage}</small>}</td>
            <td>{row.irn ?? "—"}</td><td>{row.attempts}</td><td>{timeText(row.lastAttemptAt)}</td><td>{row.status === "pending" ? timeText(row.nextRetryAt) : "—"}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "entry" : "entries"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
