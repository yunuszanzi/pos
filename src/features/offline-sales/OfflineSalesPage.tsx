import { useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllOfflineSales, reviewOfflineSale, type OfflineSaleRow } from "../../api/offlineSalesApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";

const when = (value: string | null) => (value ? new Date(value).toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }) : "—");

/** Sales rung up without a connection that went wrong in some way. They are already in the books; this is where someone looks at them. */
export function OfflineSalesPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"open" | "reviewed">("open");
  const [page, setPage] = useState(1);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const keys = useRef<Record<string, string>>({});
  const list = useQuery({ queryKey: ["offline-sales", { status, page }], queryFn: ({ signal }) => getAllOfflineSales(status, page, signal), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 25));

  async function review(row: OfflineSaleRow) {
    setError("");
    try {
      await reviewOfflineSale(row.invoiceId, notes[row.invoiceId] ?? "", (keys.current[row.invoiceId] ??= crypto.randomUUID()));
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["offline-sales"] }), queryClient.invalidateQueries({ queryKey: ["dashboard"] })]);
    } catch (caught) {
      delete keys.current[row.invoiceId];
      setError(caught instanceof Error ? caught.message : "Could not record the review");
    }
  }

  const explain = (row: OfflineSaleRow, code: string) => {
    const detail = row.detail as Record<string, number>;
    if (code === "PRICE_CHANGED" && detail.expectedTotalPaisa !== undefined) return `The till showed ${formatPkr(detail.expectedTotalPaisa)}; the books now charge ${formatPkr(detail.actualTotalPaisa)}.`;
    if (code === "DISCOUNT_OVER_LIMIT" && detail.discountLimitBps !== undefined) return `The cashier's limit is ${(detail.discountLimitBps / 100).toFixed(0)}%; no manager could approve it offline.`;
    return "";
  };

  return <div className="content">
    <PageTitle title="Offline sales to review" description="These sales were rung up while the till had no connection. They are posted and in the books; each had something a person should look at." />
    <section className="panel stack">
      <Field label="Show"><SelectInput value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}>
        <option value="open">Waiting for a look</option><option value="reviewed">Already reviewed</option>
      </SelectInput></Field>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Offline sales">
        <thead><tr><th>Sale</th><th>Made</th><th className="num">Total</th><th>What to look at</th><th>{status === "open" ? "Review" : "Reviewed"}</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.invoiceId}>
            <td><Link className="text-button" to={`/invoices/${row.invoiceId}`}>{row.number}</Link><small className="block muted">Slip {row.offlineRef}{row.cashierName ? ` · ${row.cashierName}` : ""}</small></td>
            <td>{when(row.soldAt)}</td><td className="num">{formatPkr(row.totalPaisa)}</td>
            <td>{row.flags.map((flag) => <p key={flag.code}><strong>{flag.label}</strong>{explain(row, flag.code) && <small className="block muted">{explain(row, flag.code)}</small>}</p>)}</td>
            <td>{status === "open"
              ? <div className="stack"><TextInput aria-label={`Note for ${row.number}`} placeholder="Note (optional)" maxLength={500} value={notes[row.invoiceId] ?? ""} onChange={(event) => setNotes({ ...notes, [row.invoiceId]: event.target.value })} />
                <button className="button secondary" onClick={() => void review(row)}>Mark as reviewed</button></div>
              : <>{when(row.reviewedAt)}{row.reviewedByName ? ` by ${row.reviewedByName}` : ""}{row.reviewNote && <small className="block muted">{row.reviewNote}</small>}</>}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={5} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "sale" : "sales"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
