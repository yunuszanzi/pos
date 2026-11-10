import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllDayClosings, getDayPreview, postDayClosing } from "../../api/dayClosingApi";
import { getAllBranches } from "../../api/orgApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText, momentDayText } from "../purchasing/dayText";
import { DaySummaryView } from "./DaySummaryView";

const todayKarachi = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

/** Closing a branch's day: see what the day came to, close it once every shift is closed, and look back at past closings. */
export function DayClosingPage() {
  const queryClient = useQueryClient();
  const mayClose = useCan("cash.close_day");
  const [branchId, setBranchId] = useState("");
  const [date, setDate] = useState(todayKarachi);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  // One key for this closing, so a retry after a dropped connection cannot close the day twice.
  const key = useRef(`cls-${crypto.randomUUID()}`);

  const branches = useQuery({ queryKey: ["branches"], queryFn: getAllBranches, staleTime: 5 * 60_000 });
  const preview = useQuery({ queryKey: ["day-preview", branchId, date], queryFn: ({ signal }) => getDayPreview(branchId, date, signal), enabled: Boolean(date), staleTime: 0 });
  const history = useQuery({ queryKey: ["day-closings", page], queryFn: () => getAllDayClosings(page) });
  const pageCount = Math.max(1, Math.ceil((history.data?.total ?? 0) / (history.data?.pageSize ?? 25)));
  const data = preview.data;

  async function close() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const closed = await postDayClosing({ branchId: data?.branchId, date, note }, key.current);
      key.current = `cls-${crypto.randomUUID()}`;
      setNote("");
      setNotice(`${closed.number}: ${dayText(closed.businessDate)} is closed for ${closed.branchName}.`);
      await Promise.all(["day-preview", "day-closings"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not close the day");
      key.current = `cls-${crypto.randomUUID()}`;
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="Day-end closing" description="Write down a branch's day once every shift is closed. After that no new shift can open on that day and no expense can be dated into it." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack no-print">
      <div className="form-grid">
        {(branches.data?.length ?? 0) > 1 && <Field label="Branch">
          <SelectInput value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">My branch</option>
            {(branches.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </SelectInput>
        </Field>}
        <Field label="Day"><TextInput type="date" value={date} max={todayKarachi()} onChange={(event) => setDate(event.target.value)} /></Field>
      </div>
    </section>

    {preview.isError && <ErrorMessage>{preview.error.message}</ErrorMessage>}
    {data && <>
      <h2>{data.branchName} · {dayText(data.date)}</h2>
      <DaySummaryView summary={data.summary} />
      <section className="panel stack no-print" aria-label="Close the day">
        {data.closingId
          ? <p>This day is closed. <Link className="text-button" to={`/day-closings/${data.closingId}`}>Open the closing</Link></p>
          : <>
            {data.openShifts && <ErrorMessage>A shift is still open on {data.openShifts}. Close it at the till (count the drawer) before closing the day.</ErrorMessage>}
            {mayClose && <>
              <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
              <div className="button-row"><button className="button primary" disabled={busy || Boolean(data.openShifts)} onClick={() => void close()}>{busy ? "Closing…" : "Close the day"}</button></div>
            </>}
            {!mayClose && <p className="muted">You may look at the day but not close it.</p>}
          </>}
      </section>
    </>}

    <section className="panel stack no-print">
      <h2>Past closings</h2>
      <div className="table-scroll"><table aria-label="Past closings">
        <thead><tr><th>Closing</th><th>Branch</th><th>Day</th><th>Closed</th><th className="num">Sales</th><th className="num">Cash difference</th></tr></thead>
        <tbody>
          {(history.data?.data ?? []).map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/day-closings/${row.id}`}>{row.number}</Link>{row.reopened && <small className="block muted">Reopened</small>}</td>
            <td>{row.branchName}</td><td>{dayText(row.businessDate)}</td><td>{momentDayText(row.closedAt)}{row.closedByName ? ` by ${row.closedByName}` : ""}</td>
            <td className="num">{formatPkr(row.salesPaisa)}</td><td className="num">{formatPkr(row.cashVariancePaisa)}</td>
          </tr>)}
          {history.isSuccess && history.data.data.length === 0 && <tr><td colSpan={6} className="muted">No day has been closed yet.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
