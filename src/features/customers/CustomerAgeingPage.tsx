import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ageingBands, reminderMessage, whatsappLink } from "../../../shared/khata";
import { formatPkr } from "../../../shared/money";
import { getAllAreas, getCustomerAgeing } from "../../api/customersApi";
import { getAppBootstrapData } from "../../api/posApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { useTerminalStore } from "../../app/terminalStore";

const pageSize = 25;
const money = (paisa: number) => (paisa ? formatPkr(paisa) : "");

/** Who owes what and for how long (0–30, 31–60, 61–90, over 90 days), with a WhatsApp reminder ready to send to each. */
export function CustomerAgeingPage() {
  const maySell = useCan("sales.create");
  const terminalId = useTerminalStore((state) => state.terminalId);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [areaId, setAreaId] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const areas = useQuery({ queryKey: ["areas"], queryFn: getAllAreas, staleTime: 5 * 60_000 });
  const report = useQuery({
    queryKey: ["customer-ageing", { search, areaId, overdueOnly, page }],
    queryFn: ({ signal }) => getCustomerAgeing({ q: search, areaId, overdue: overdueOnly, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  // The shop's name in the reminder comes from the same bootstrap call the till makes, shared by its cache key.
  const setup = useQuery({ queryKey: ["pos-bootstrap", terminalId], queryFn: getAppBootstrapData, staleTime: Infinity, enabled: maySell });
  const rows = report.data?.data ?? [];
  const total = report.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const totals = report.data?.totals;

  return <div className="content">
    <PageTitle title="Customer ageing" description="What customers owe, by how old the debt is. A payment is counted against the oldest debt first." />
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search customers" placeholder="Name, business or phone" value={text} onChange={(event) => setText(event.target.value)} />
        <SelectInput aria-label="Area" value={areaId} onChange={(event) => { setAreaId(event.target.value); setPage(1); }}>
          <option value="">All areas</option>{(areas.data ?? []).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </SelectInput>
        <label className="check"><input type="checkbox" checked={overdueOnly} onChange={(event) => { setOverdueOnly(event.target.checked); setPage(1); }} /> Overdue only</label>
      </div>
      {report.isError && <ErrorMessage>{report.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Ageing">
        <thead><tr><th>Customer</th>{ageingBands.map((band) => <th key={band} className="num">{band} days</th>)}<th className="num">Owes</th><th /></tr></thead>
        <tbody>
          {rows.map((row) => {
            const link = whatsappLink(row.whatsapp || row.phone, reminderMessage({
              customerName: row.name, businessName: setup.data?.business.tradeName ?? "us", balancePaisa: row.owedPaisa, overdueDays: row.overdue ? row.oldestDays : undefined,
            }));
            return <tr key={row.customerId}>
              <td><strong>{row.name}</strong>{row.businessName && <small className="block muted">{row.businessName}</small>}{row.overdue && <span className="status">Overdue</span>}</td>
              {row.bandsPaisa.map((value, band) => <td key={band} className="num">{money(value)}</td>)}
              <td className="num"><strong>{formatPkr(row.owedPaisa)}</strong></td>
              <td className="action-cell">
                <Link className="text-button" to={`/customers/${row.customerId}/ledger`}>Khata</Link>
                {link && <a className="text-button" href={link} target="_blank" rel="noreferrer" aria-label={`Remind ${row.name} on WhatsApp`}>Remind</a>}
              </td>
            </tr>;
          })}
          {report.isSuccess && rows.length === 0 && <tr><td colSpan={7} className="muted">{overdueOnly ? "No customer is past their payment terms." : "Nobody owes anything."}</td></tr>}
        </tbody>
        {totals && total > 0 && <tfoot><tr>
          <th>Total · {total} {total === 1 ? "customer" : "customers"}</th>
          {totals.bandsPaisa.map((value, band) => <th key={band} className="num">{money(value)}</th>)}
          <th className="num" data-testid="ageing-total">{formatPkr(totals.owedPaisa)}</th><th />
        </tr></tfoot>}
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
