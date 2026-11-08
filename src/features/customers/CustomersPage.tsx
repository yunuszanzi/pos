import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { archiveCustomer, getAllAreas, getAllCustomerGroups, getAllCustomers, type Customer } from "../../api/customersApi";
import { ErrorMessage, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";

const pageSize = 25;
const staleTime = 5 * 60_000;

export function CustomersPage() {
  const queryClient = useQueryClient();
  const canManage = useCan("customers.manage");
  const canLedger = useCan("customers.ledger");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<"true" | "false" | "all">("true");
  const [areaId, setAreaId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Wait for a pause in typing before asking the server (300 ms, technical-plan 5.7).
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const areas = useQuery({ queryKey: ["areas"], queryFn: getAllAreas, staleTime });
  const groups = useQuery({ queryKey: ["customer-groups"], queryFn: getAllCustomerGroups, staleTime });
  const customers = useQuery({
    queryKey: ["customers", { q: debounced, status, areaId, groupId, page }],
    queryFn: ({ signal }) => getAllCustomers({ q: debounced, active: status, areaId, groupId, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const areaName = new Map((areas.data ?? []).map((area) => [area.id, area.name]));
  const groupName = new Map((groups.data ?? []).map((group) => [group.id, group.name]));
  const rows = customers.data?.data ?? [];
  const total = customers.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function archive(customer: Customer) {
    setError("");
    setNotice("");
    try {
      await archiveCustomer(customer.id);
      setNotice(`${customer.name} was archived. Their history is kept.`);
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not archive the customer");
    }
  }

  return <div className="content">
    <PageTitle title="Customers" description="Search by name, business name or phone number. A customer's price tier applies automatically at the till." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search customers" placeholder="Name, business or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
        <SelectInput aria-label="Status" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}>
          <option value="true">Active</option><option value="false">Archived</option><option value="all">All</option>
        </SelectInput>
        <SelectInput aria-label="Area" value={areaId} onChange={(event) => { setAreaId(event.target.value); setPage(1); }}>
          <option value="">All areas</option>{(areas.data ?? []).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </SelectInput>
        <SelectInput aria-label="Group" value={groupId} onChange={(event) => { setGroupId(event.target.value); setPage(1); }}>
          <option value="">All groups</option>{(groups.data ?? []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </SelectInput>
      </div>
      {canManage && <div className="button-row">
        <Link className="button primary" to="/customers/new">New customer</Link>
        <Link className="button secondary" to="/customers/setup">Groups &amp; areas</Link>
      </div>}
      {customers.isError && <ErrorMessage>{customers.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Customers">
        <thead><tr><th>Name</th><th>Phone</th><th>Area</th><th>Group</th><th className="num">Credit limit</th><th className="num">Balance</th><th>Terms</th><th /></tr></thead>
        <tbody>
          {rows.map((customer) => <tr key={customer.id}>
            <td><strong>{customer.name}</strong>{customer.businessName && <small className="block muted">{customer.businessName}</small>}{!customer.active && <span className="status">Archived</span>}</td>
            <td>{customer.phone || customer.whatsapp}</td>
            <td>{(customer.areaId && areaName.get(customer.areaId)) || ""}</td>
            <td>{(customer.groupId && groupName.get(customer.groupId)) || ""}</td>
            <td className="num">{customer.creditLimitPaisa > 0 ? formatPkr(customer.creditLimitPaisa) : "No credit"}</td>
            <td className="num">{customer.balancePaisa === undefined ? "" : customer.balancePaisa < 0 ? `${formatPkr(-customer.balancePaisa)} credit` : formatPkr(customer.balancePaisa)}</td>
            <td>{customer.termsDays > 0 ? `${customer.termsDays} days` : ""}</td>
            <td className="action-cell">
              {canLedger && <Link className="text-button" to={`/customers/${customer.id}/ledger`}>Khata</Link>}
              {canManage && <Link className="text-button" to={`/customers/${customer.id}`}>Edit</Link>}
              {canManage && customer.active && <button className="text-button" onClick={() => void archive(customer)}>Archive</button>}
            </td>
          </tr>)}
          {customers.isSuccess && rows.length === 0 && <tr><td colSpan={8} className="muted">No customers found.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "customer" : "customers"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
