import { useState, type FormEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getAllUnits } from "../../api/catalogueApi";
import {
  approveStockAdjustment, getAllStockAdjustments, getStockAdjustmentById, rejectStockAdjustment, type AdjustmentStatus,
} from "../../api/inventoryApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { adjustmentReasonLabels, groupDigits } from "./stockFormat";
import { StockTabs } from "./StockTabs";

const pageSize = 15;
const statusLabels: Record<AdjustmentStatus, string> = { pending: "Waiting for approval", approved: "Approved", rejected: "Rejected" };

export function AdjustmentsPage() {
  const queryClient = useQueryClient();
  const canAdjust = useCan("inventory.adjust");
  const canApprove = useCan("inventory.approve");
  const location = useLocation() as { state: { notice?: string } | null };
  const [params, setParams] = useSearchParams();
  const openId = params.get("open") ?? "";
  const [status, setStatus] = useState<"" | AdjustmentStatus>("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(location.state?.notice ?? "");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const units = useQuery({ queryKey: ["units"], queryFn: getAllUnits, staleTime: 5 * 60_000 });
  const list = useQuery({
    queryKey: ["adjustments", { status, page }],
    queryFn: () => getAllStockAdjustments({ status: status || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
  });
  const detail = useQuery({ queryKey: ["adjustment", openId], queryFn: () => getStockAdjustmentById(openId), enabled: Boolean(openId) });

  const unitName = (unitId: string) => units.data?.find((unit) => unit.id === unitId)?.name ?? "";
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showsValue = list.data?.data.some((row) => row.totalValuePaisa !== undefined) ?? false;

  async function refresh() {
    await Promise.all(["adjustments", "adjustment", "stock", "ledger"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  }

  async function decide(work: () => Promise<unknown>, done: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await work();
      setNotice(done);
      setRejecting(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the decision");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function reject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "");
    void decide(() => rejectStockAdjustment(openId, reason), "Adjustment rejected. Stock was not changed.");
  }

  return <div className="content">
    <PageTitle title="Stock adjustments" description="Damage, loss, found stock and corrections. Large ones wait for someone allowed to approve them; stock changes only when they are approved." />
    <StockTabs />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <div className="form-actions">
        <label className="field"><span>Show</span>
          <SelectInput value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}>
            <option value="">All adjustments</option>
            {(Object.keys(statusLabels) as AdjustmentStatus[]).map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}
          </SelectInput>
        </label>
      </div>
      {canAdjust && <div className="button-row"><Link className="button primary" to="/stock/adjustments/new">New adjustment</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table>
        <thead><tr><th>Date</th><th>Reason</th><th>Location</th><th>Lines</th>{showsValue && <th>Value</th>}<th>By</th><th>Status</th><th /></tr></thead>
        <tbody>{(list.data?.data ?? []).map((row) => <tr key={row.id}>
          <td>{new Date(row.createdAt).toLocaleString()}</td>
          <td>{adjustmentReasonLabels[row.reason] ?? row.reason}</td>
          <td>{row.locationName}</td>
          <td>{row.lineCount}</td>
          {showsValue && <td>{row.totalValuePaisa === undefined ? "" : formatPkr(row.totalValuePaisa)}</td>}
          <td>{row.createdByName ?? "—"}</td>
          <td><span className={row.status === "approved" ? "status active" : "status"}>{statusLabels[row.status]}</span></td>
          <td className="action-cell"><button className="text-button" type="button" onClick={() => { setParams({ open: row.id }); setRejecting(false); }}>View</button></td>
        </tr>)}</tbody>
      </table></div>
      {list.isPending && <p className="muted">Loading adjustments…</p>}
      {list.data && !list.data.data.length && <p className="muted">No adjustments yet.</p>}
      <div className="button-row">
        <button className="button secondary" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted" role="status">Page {page} of {pageCount} · {total} adjustment{total === 1 ? "" : "s"}</span>
        <button className="button secondary" type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>

    {openId && <section className="panel stack" aria-label="Adjustment details">
      {detail.isPending && <p className="muted">Loading…</p>}
      {detail.isError && <ErrorMessage>{detail.error.message}</ErrorMessage>}
      {detail.data && <>
        <h2>{adjustmentReasonLabels[detail.data.reason] ?? detail.data.reason} · {detail.data.locationName}</h2>
        <p className="muted">
          {statusLabels[detail.data.status]} · requested by {detail.data.createdByName ?? "unknown"} on {new Date(detail.data.createdAt).toLocaleString()}
          {detail.data.approvedByName && ` · decided by ${detail.data.approvedByName}`}
        </p>
        {detail.data.note && <p style={{ whiteSpace: "pre-line" }}>{detail.data.note}</p>}
        <div className="table-scroll"><table>
          <thead><tr><th>SKU</th><th>Product</th><th>Quantity</th><th>In base units</th>{detail.data.totalValuePaisa !== undefined && <th>Cost per base unit</th>}</tr></thead>
          <tbody>{detail.data.lines.map((line) => <tr key={line.variantId}>
            <td className="mono">{line.sku}</td>
            <td>{line.productName}{line.variantName && <small className="muted"> · {line.variantName}</small>}</td>
            <td>{line.qtyEntered.startsWith("-") ? "" : "+"}{groupDigits(line.qtyEntered)} {unitName(line.unitId)}</td>
            <td>{line.qtyBaseDelta.startsWith("-") ? "" : "+"}{groupDigits(line.qtyBaseDelta)}</td>
            {detail.data.totalValuePaisa !== undefined && <td>{line.unitCostPaisa === undefined ? "" : formatPkr(line.unitCostPaisa)}</td>}
          </tr>)}</tbody>
        </table></div>
        {detail.data.totalValuePaisa !== undefined && <p><strong>Total value: {formatPkr(detail.data.totalValuePaisa)}</strong></p>}
        {detail.data.status === "pending" && canApprove && !rejecting && <div className="button-row">
          <button className="button primary" type="button" disabled={busy} onClick={() => void decide(() => approveStockAdjustment(detail.data.id, crypto.randomUUID()), "Adjustment approved and posted to stock.")}>{busy ? "Working…" : "Approve"}</button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button>
        </div>}
        {detail.data.status === "pending" && canApprove && rejecting && <form className="stack" onSubmit={reject}>
          <Field label="Reason for rejecting"><TextInput name="reason" required maxLength={300} /></Field>
          <div className="button-row">
            <button className="button primary" disabled={busy}>Reject adjustment</button>
            <button className="button secondary" type="button" onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </form>}
        {detail.data.status === "pending" && !canApprove && <p className="muted">Waiting for someone with approval rights.</p>}
        <div className="button-row"><button className="text-button" type="button" onClick={() => setParams({})}>Close</button></div>
      </>}
    </section>}
  </div>;
}
