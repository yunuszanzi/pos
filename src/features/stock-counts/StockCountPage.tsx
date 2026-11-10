import { useEffect, useRef, useState, type FormEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { stockCountStatusLabels } from "../../../shared/schemas/stockCounts";
import { moveStockCount, postCountEntries, postCountScan, getStockCountById, type CountLine, type CountLineFilter } from "../../api/stockCountsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { QuantityInput } from "../../app/QuantityInput";
import { useCan } from "../../app/permissions";
import { groupDigits } from "../stock/stockFormat";

const when = (value: string | null) => (value ? new Date(value).toLocaleString("en-PK", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }) : "—");
const signed = (value: string) => (value.startsWith("-") || value === "0" ? groupDigits(value) : `+${groupDigits(value)}`);

/** Counting a shelf, then reviewing the variance. Scan or type; nothing changes stock until the count is approved. */
export function StockCountPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayCount = useCan("inventory.count");
  const mayApprove = useCan("inventory.approve");
  const [filter, setFilter] = useState<NonNullable<CountLineFilter["filter"]>>("all");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [scanCode, setScanCode] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [reviewNote, setReviewNote] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const keys = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (keys.current[action] ??= crypto.randomUUID());

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const detail = useQuery({
    queryKey: ["stock-count", id, { filter, search, page }],
    queryFn: ({ signal }) => getStockCountById(id, { filter, q: search, page, pageSize: 100 }, signal),
    placeholderData: keepPreviousData,
  });
  const count = detail.data;
  const counting = count?.status === "counting";
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["stock-count", id] }), queryClient.invalidateQueries({ queryKey: ["stock-counts"] })]);

  async function scan(event: FormEvent) {
    event.preventDefault();
    const code = scanCode.trim();
    if (!code) return;
    // "3*CODE" counts three at once, as at the till.
    const multiple = /^(\d{1,6}(?:\.\d{1,3})?)\*(.+)$/.exec(code);
    setError(""); setDone("");
    try {
      const result = await postCountScan(id, { code: multiple ? multiple[2] : code, quantity: multiple ? multiple[1] : "1" });
      setDone(`${result.productName} (${result.sku}): ${groupDigits(result.countedBase)} counted`);
      setScanCode("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not count that");
    }
    scanRef.current?.focus();
  }

  async function saveTyped(line: CountLine) {
    const quantity = typed[line.variantId]?.trim();
    if (quantity === undefined || quantity === "") return;
    setError(""); setDone("");
    try {
      await postCountEntries(id, { mode: "set", entries: [{ variantId: line.variantId, unitId: line.baseUnitId, quantity }] });
      setTyped((current) => { const next = { ...current }; delete next[line.variantId]; return next; });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that count");
    }
  }

  async function move(action: "submit" | "reopen" | "approve" | "cancel", message: string) {
    setBusy(true); setError(""); setDone("");
    try {
      await moveStockCount(id, action, reviewNote, keyFor(action));
      keys.current = {};
      setDone(message);
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ["stock"] })]);
    } catch (caught) {
      keys.current = {};
      setError(caught instanceof Error ? caught.message : "That did not work");
    } finally {
      setBusy(false);
    }
  }

  if (detail.isError) return <div className="content"><ErrorMessage>{detail.error.message}</ErrorMessage></div>;
  if (!count) return <div className="content"><p className="muted">Loading…</p></div>;
  const summary = count.summary;
  const withValue = summary.netValuePaisa !== undefined;
  const pageCount = Math.max(1, Math.ceil(count.lines.total / 100));
  return <div className="content">
    <PageTitle title={`${count.number} — ${stockCountStatusLabels[count.status]}`} description={`${count.scope === "full" ? "Full count" : "Count of chosen items"} at ${count.locationName}`} />
    <p><Link className="text-button" to="/stock-counts">← Back to counts</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {done && <SuccessMessage>{done}</SuccessMessage>}

    <section className="panel stack" aria-label="Summary">
      <dl className="totals">
        <div><dt>Status</dt><dd data-testid="count-status">{stockCountStatusLabels[count.status]}</dd></div>
        <div><dt>Counted</dt><dd data-testid="count-progress">{summary.counted} of {summary.items} items</dd></div>
        <div><dt>Differences</dt><dd data-testid="count-differences">{summary.differences} items · {groupDigits(summary.overUnits)} over · {groupDigits(summary.shortUnits)} short</dd></div>
        {withValue && <div><dt>Value of differences</dt><dd data-testid="count-value">{formatPkr(summary.netValuePaisa ?? 0)} ({formatPkr(summary.overValuePaisa ?? 0)} over, {formatPkr(summary.shortValuePaisa ?? 0)} short)</dd></div>}
        <div><dt>Started</dt><dd>{when(count.startedAt)}{count.createdByName ? ` by ${count.createdByName}` : ""}</dd></div>
        {count.submittedAt && <div><dt>Handed in</dt><dd>{when(count.submittedAt)}{count.submittedByName ? ` by ${count.submittedByName}` : ""}</dd></div>}
        {count.approvedAt && <div><dt>Approved</dt><dd>{when(count.approvedAt)}{count.approvedByName ? ` by ${count.approvedByName}` : ""}</dd></div>}
      </dl>
      {summary.uncounted > 0 && count.status !== "cancelled" && <p className="muted">{summary.uncounted} items have not been counted. They are left as they are; they are not taken to be zero.</p>}
      {count.reviewNote && <p className="muted">Review note: {count.reviewNote}</p>}
      {count.adjustmentId && <p><Link className="text-button" to="/stock/adjustments">The stock adjustment this count posted</Link></p>}
    </section>

    {counting && mayCount && <section className="panel stack" aria-label="Scan">
      <form onSubmit={(event) => void scan(event)} className="form-grid">
        <Field label="Scan or type a barcode"><TextInput ref={scanRef} value={scanCode} onChange={(event) => setScanCode(event.target.value)} placeholder="Barcode or SKU; 3*CODE counts three" autoFocus autoComplete="off" /></Field>
        <button className="button primary">Count it</button>
      </form>
    </section>}

    <section className="panel stack">
      <div className="form-grid">
        <Field label="Show"><SelectInput value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setPage(1); }}>
          <option value="all">All items</option><option value="uncounted">Not counted yet</option><option value="differences">Differences only</option>
        </SelectInput></Field>
        <Field label="Search"><TextInput aria-label="Search the count" placeholder="Name, SKU or barcode" value={text} onChange={(event) => setText(event.target.value)} /></Field>
      </div>
      <div className="table-scroll"><table aria-label="Count lines">
        <thead><tr><th>Item</th><th className="num">Books said</th><th className="num">Counted</th><th className="num">Difference</th><th className="num">Moved since</th>{withValue && <th className="num">Value</th>}</tr></thead>
        <tbody>
          {count.lines.data.map((line) => <tr key={line.variantId} data-testid={`line-${line.sku}`}>
            <td>{line.productName}{line.variantName && <small className="muted"> · {line.variantName}</small>} <span className="mono">{line.sku}</span></td>
            <td className="num">{groupDigits(line.expectedBase)}</td>
            <td className="num">{counting && mayCount
              ? <QuantityInput aria-label={`Counted ${line.sku}`} value={typed[line.variantId] ?? (line.countedBase ?? "")} placeholder="—"
                  onChange={(event) => setTyped({ ...typed, [line.variantId]: event.target.value })} onBlur={() => void saveTyped(line)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              : line.countedBase === null ? "Not counted" : groupDigits(line.countedBase)}</td>
            <td className="num" data-testid={`variance-${line.sku}`}>{line.varianceBase === null ? "—" : signed(line.varianceBase)}</td>
            <td className="num">{line.movedSinceBase === "0" ? "—" : signed(line.movedSinceBase)}</td>
            {withValue && <td className="num">{line.varianceValuePaisa == null ? "—" : formatPkr(line.varianceValuePaisa)}</td>}
          </tr>)}
          {detail.isSuccess && count.lines.data.length === 0 && <tr><td colSpan={withValue ? 6 : 5} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {count.lines.total} items</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>

    {(count.status === "counting" || count.status === "submitted") && <section className="panel stack" aria-label="Finish">
      {(count.status === "submitted" ? mayApprove : mayCount) && <Field label="Note (optional)"><TextInput value={reviewNote} maxLength={500} onChange={(event) => setReviewNote(event.target.value)} /></Field>}
      <div className="button-row">
        {count.status === "counting" && mayCount && <button className="button primary" disabled={busy || summary.counted === 0} onClick={() => void move("submit", "Handed in for review.")}>Finished counting: hand in for review</button>}
        {count.status === "submitted" && mayApprove && <button className="button primary" disabled={busy} onClick={() => void move("approve", "Approved. Stock now matches the count.")}>Approve and correct the stock</button>}
        {count.status === "submitted" && mayApprove && <button className="button secondary" disabled={busy} onClick={() => void move("reopen", "Sent back for a recount of the differences.")}>Send back for a recount</button>}
        {mayCount && <button className="button secondary" disabled={busy} onClick={() => void move("cancel", "Count cancelled. Stock was not changed.")}>Cancel this count</button>}
      </div>
      {count.status === "submitted" && <p className="muted">Approving changes stock by each difference shown above, measured against what the books said when the count started.</p>}
    </section>}
  </div>;
}
