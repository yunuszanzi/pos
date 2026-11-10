import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { archiveSupplier, getAllSuppliers, type Supplier } from "../../api/suppliersApi";
import { ErrorMessage, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";

const pageSize = 25;

export function SuppliersPage() {
  const queryClient = useQueryClient();
  const canManage = useCan("suppliers.manage");
  const canLedger = useCan("suppliers.ledger");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<"true" | "false" | "all">("true");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Wait for a pause in typing before asking the server (300 ms, technical-plan 5.7).
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const suppliers = useQuery({
    queryKey: ["suppliers", { q: debounced, status, page }],
    queryFn: ({ signal }) => getAllSuppliers({ q: debounced, active: status, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = suppliers.data?.data ?? [];
  const total = suppliers.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function archive(supplier: Supplier) {
    setError("");
    setNotice("");
    try {
      await archiveSupplier(supplier.id);
      setNotice(`${supplier.name} was archived. Their history is kept.`);
      await queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not archive the supplier");
    }
  }

  return <div className="content">
    <PageTitle title="Suppliers" description="The people you buy from. Search by name, contact or phone number." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search suppliers" placeholder="Name, contact or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
        <SelectInput aria-label="Status" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}>
          <option value="true">Active</option><option value="false">Archived</option><option value="all">All</option>
        </SelectInput>
      </div>
      {canManage && <div className="button-row">
        <Link className="button primary" to="/suppliers/new">New supplier</Link>
        {canLedger && <Link className="button secondary" to="/suppliers/opening-payables">Opening payables</Link>}
      </div>}
      {suppliers.isError && <ErrorMessage>{suppliers.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Suppliers">
        <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Terms</th><th className="num">We owe</th><th /></tr></thead>
        <tbody>
          {rows.map((supplier) => <tr key={supplier.id}>
            <td><strong>{supplier.name}</strong>{!supplier.active && <span className="status">Archived</span>}</td>
            <td>{supplier.contactPerson}</td>
            <td>{supplier.phone || supplier.whatsapp}</td>
            <td>{supplier.termsDays > 0 ? `${supplier.termsDays} days` : "On receipt"}</td>
            <td className="num">{supplier.balancePaisa === undefined ? "" : supplier.balancePaisa < 0 ? `${formatPkr(-supplier.balancePaisa)} credit` : formatPkr(supplier.balancePaisa)}</td>
            <td className="action-cell">
              {canLedger && <Link className="text-button" to={`/suppliers/${supplier.id}/ledger`}>Ledger</Link>}
              {canManage && <Link className="text-button" to={`/suppliers/${supplier.id}`}>Edit</Link>}
              {canManage && supplier.active && <button className="text-button" onClick={() => void archive(supplier)}>Archive</button>}
            </td>
          </tr>)}
          {suppliers.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">No suppliers found.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "supplier" : "suppliers"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
