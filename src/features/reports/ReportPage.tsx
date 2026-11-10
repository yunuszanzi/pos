import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { reportCellText, type ReportFilterKey } from "../../../shared/reports";
import { getAllCategories } from "../../api/catalogueApi";
import { getAllBranches, getAllLocations, getAllTerminals } from "../../api/orgApi";
import { getAllAccounts } from "../../api/accountsApi";
import { downloadReportCsv, getReportCatalogue, getReportData, type ReportFilters } from "../../api/reportsApi";
import { getAllUsers } from "../../api/usersApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { CustomerPicker, type PickedCustomer } from "../customers/CustomerPicker";
import { ProductPicker } from "../products/ProductPicker";
import { SupplierPicker, type PickedSupplier } from "../suppliers/SupplierPicker";

const pageSize = 50;

/** yyyy-mm-dd arithmetic done in UTC so a time zone never moves the day. */
const shiftDays = (day: string, days: number) => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);
const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const lastMonth = (day: string) => {
  const first = new Date(Date.parse(monthStart(day)));
  const end = new Date(first.getTime() - 86_400_000);
  return { from: `${end.toISOString().slice(0, 8)}01`, to: end.toISOString().slice(0, 10) };
};

/** One report: its filters, the rows with a totals line, paging, a spreadsheet export and a print. */
export function ReportPage() {
  const { key = "" } = useParams();
  const catalogue = useQuery({ queryKey: ["report-catalogue"], queryFn: getReportCatalogue, staleTime: 60_000 });
  const info = catalogue.data?.data.find((report) => report.key === key);
  const today = catalogue.data?.today ?? "";

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [chosen, setChosen] = useState<ReportFilters>({});
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [supplier, setSupplier] = useState<PickedSupplier | null>(null);
  const [product, setProduct] = useState<{ id: string; sku: string } | null>(null);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [days, setDays] = useState("90");
  const [page, setPage] = useState(1);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);

  // The dates start at this month, once the server has said what today is.
  useEffect(() => {
    if (today && !from && !to) { setFrom(monthStart(today)); setTo(today); }
  }, [today, from, to]);
  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const wants = (filter: ReportFilterKey) => Boolean(info?.filters.includes(filter));
  const filters: ReportFilters = useMemo(() => ({
    ...(wants("dates") ? { from, to } : {}), ...chosen,
    ...(customer ? { customerId: customer.id } : {}), ...(supplier ? { supplierId: supplier.id } : {}), ...(product ? { variantId: product.id } : {}),
    ...(wants("days") ? { days } : {}), ...(wants("q") ? { q: search } : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [info, from, to, chosen, customer, supplier, product, days, search]);

  const mayUsers = useCan("users.view");
  const mayAccounts = useCan("accounts.view");
  const branches = useQuery({ queryKey: ["branches"], queryFn: getAllBranches, staleTime: 5 * 60_000, enabled: wants("branchId") });
  const terminals = useQuery({ queryKey: ["terminals"], queryFn: getAllTerminals, staleTime: 5 * 60_000, enabled: wants("terminalId") });
  const users = useQuery({ queryKey: ["users", "report-filter"], queryFn: () => getAllUsers(1, 100), staleTime: 5 * 60_000, enabled: wants("userId") && mayUsers });
  const categories = useQuery({ queryKey: ["categories"], queryFn: getAllCategories, staleTime: 5 * 60_000, enabled: wants("categoryId") });
  const locations = useQuery({ queryKey: ["locations"], queryFn: getAllLocations, staleTime: 5 * 60_000, enabled: wants("locationId") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAllAccounts, staleTime: 60_000, enabled: wants("accountId") && mayAccounts });

  const ready = Boolean(info) && (!wants("dates") || Boolean(from && to));
  const result = useQuery({
    queryKey: ["report", key, filters, page],
    queryFn: ({ signal }) => getReportData(key, filters, page, pageSize, signal),
    enabled: ready,
    placeholderData: keepPreviousData,
  });

  const change = (name: keyof ReportFilters, value: string) => { setChosen((current) => ({ ...current, [name]: value })); setPage(1); };
  const setRange = (start: string, end: string) => { setFrom(start); setTo(end); setPage(1); };

  async function exportCsv() {
    setExporting(true);
    setExportError("");
    try {
      await downloadReportCsv(key, filters);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "Could not export the report");
    } finally {
      setExporting(false);
    }
  }

  if (catalogue.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (!info) return <div className="content"><PageTitle title="Report not available" /><p className="muted">This report does not exist, or you do not have permission to see it. <Link className="text-button" to="/reports">Back to reports</Link></p></div>;

  const data = result.data;
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const select = (label: string, name: keyof ReportFilters, options: Array<{ id: string; name: string }>, all: string) => (
    <Field label={label}>
      <SelectInput value={chosen[name] ?? ""} onChange={(event) => change(name, event.target.value)}>
        <option value="">{all}</option>
        {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </SelectInput>
    </Field>
  );

  return <div className="content">
    <PageTitle title={info.title} description={info.description} />
    <p className="no-print"><Link className="text-button" to="/reports">← Back to reports</Link></p>
    <section className="panel stack no-print" aria-label="Filters">
      <div className="form-grid">
        {wants("dates") && <>
          <Field label="From"><TextInput type="date" value={from} max={to || today} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
          <Field label="To"><TextInput type="date" value={to} min={from} max={today} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
        </>}
        {wants("branchId") && select("Branch", "branchId", branches.data ?? [], "All branches")}
        {wants("terminalId") && select("Terminal", "terminalId", terminals.data ?? [], "All terminals")}
        {wants("userId") && mayUsers && select("Person", "userId", (users.data?.data ?? []).map((user) => ({ id: user.id, name: user.displayName })), "Everyone")}
        {wants("categoryId") && select("Category", "categoryId", categories.data ?? [], "All categories")}
        {wants("locationId") && select("Location", "locationId", locations.data ?? [], "All locations")}
        {wants("accountId") && mayAccounts && select("Account", "accountId", accounts.data?.data ?? [], "All accounts")}
        {wants("days") && <Field label="Not sold for (days)"><TextInput inputMode="numeric" value={days} onChange={(event) => { setDays(event.target.value.replace(/\D/g, "").slice(0, 4)); setPage(1); }} /></Field>}
        {wants("q") && <Field label="Search"><TextInput aria-label="Search the report" value={text} onChange={(event) => setText(event.target.value)} /></Field>}
      </div>
      {wants("customerId") && <CustomerPicker value={customer} onChange={(value) => { setCustomer(value); setPage(1); }} />}
      {wants("supplierId") && <SupplierPicker value={supplier} onChange={(value) => { setSupplier(value); setPage(1); }} />}
      {wants("variantId") && (product
        ? <p>Product: <strong>{product.sku}</strong> <button type="button" className="text-button" onClick={() => { setProduct(null); setPage(1); }}>change</button></p>
        : <ProductPicker label="Only one product" isPicked={() => false} onPick={(_, variant) => { setProduct({ id: variant.id, sku: variant.sku }); setPage(1); }} />)}
      {wants("dates") && today && <div className="button-row">
        <button type="button" className="button secondary" onClick={() => setRange(today, today)}>Today</button>
        <button type="button" className="button secondary" onClick={() => setRange(shiftDays(today, -6), today)}>Last 7 days</button>
        <button type="button" className="button secondary" onClick={() => setRange(monthStart(today), today)}>This month</button>
        <button type="button" className="button secondary" onClick={() => { const last = lastMonth(today); setRange(last.from, last.to); }}>Last month</button>
      </div>}
    </section>

    <section className="panel stack">
      {data && <p className="muted">{wants("dates") ? `${data.from} to ${data.to}` : "As of now"} · {data.total} {data.total === 1 ? "row" : "rows"}</p>}
      {result.isError && <ErrorMessage>{result.error.message}</ErrorMessage>}
      {exportError && <ErrorMessage>{exportError}</ErrorMessage>}
      {result.isPending && ready && <p className="muted">Loading…</p>}
      {data && <div className="table-scroll"><table aria-label={info.title}>
        <thead><tr>{data.columns.map((column) => <th key={column.key} className={column.type === "money" || column.type === "int" || column.type === "percent" || column.type === "qty" ? "num" : undefined}>{column.label}</th>)}</tr></thead>
        <tbody>
          {data.rows.map((row, index) => <tr key={index}>
            {data.columns.map((column) => <td key={column.key} className={column.type === "money" || column.type === "int" || column.type === "percent" || column.type === "qty" ? "num" : undefined}>{reportCellText(column, row[column.key])}</td>)}
          </tr>)}
          {data.rows.length === 0 && <tr><td colSpan={data.columns.length} className="muted">Nothing to show for these choices.</td></tr>}
        </tbody>
        {data.totals && <tfoot><tr>
          {data.columns.map((column, index) => <th key={column.key} className={column.type === "money" || column.type === "int" ? "num" : undefined} data-testid={column.sum ? `total-${column.key}` : undefined}>
            {index === 0 ? "Total" : column.sum ? reportCellText(column, data.totals?.[column.key] ?? 0) : ""}
          </th>)}
        </tr></tfoot>}
      </table></div>}
      <div className="button-row no-print">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
      <div className="button-row no-print">
        <button className="button primary" disabled={exporting || !data} onClick={() => void exportCsv()}>{exporting ? "Preparing…" : "Export to a spreadsheet (CSV)"}</button>
        <button className="button secondary" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
    </section>
  </div>;
}
