import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { formatDocumentDate, printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getAppBootstrapData } from "../../api/posApi";
import { getAllReturns, reprintReturn } from "../../api/returnsApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { useTerminalStore } from "../../app/terminalStore";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";

const pageSize = 25;

/** Credit notes for goods taken back, newest first. Returns themselves are taken at the till; here they are found and reprinted. */
export function ReturnsPage() {
  const mayReprint = useCan("sales.reprint");
  const maySell = useCan("sales.create");
  const canReprint = mayReprint && maySell;
  const terminalId = useTerminalStore((state) => state.terminalId);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [format, setFormat] = useState<PrintFormat>("a4");
  const [job, setJob] = useState<PrintJob | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({ queryKey: ["returns", search, page], queryFn: ({ signal }) => getAllReturns({ q: search, page, pageSize }, signal), placeholderData: keepPreviousData });
  // The business details printed on a credit note come from the same bootstrap call the till makes, shared by its cache key.
  const setup = useQuery({ queryKey: ["pos-bootstrap", terminalId], queryFn: getAppBootstrapData, staleTime: Infinity, enabled: canReprint });
  const settings = setup.data?.settings;
  const dateOf = (iso: string) => formatDocumentDate(iso, settings?.dateFormat ?? "dd/MM/yyyy", settings?.timezone ?? "Asia/Karachi");
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function reprint(id: string) {
    if (!setup.data) return;
    setBusy(id);
    setError("");
    try {
      const copy = await reprintReturn(id, format);
      setJob({
        business: setup.data.business, dateFormat: setup.data.settings.dateFormat, timezone: setup.data.settings.timezone,
        format: copy.format, creditNote: copy.creditNote, duplicate: { copyNumber: copy.reprintNumber },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reprint the credit note");
    } finally {
      setBusy("");
    }
  }

  return <div className="content">
    <PageTitle title="Returns & credit notes" description="Goods are taken back at the till (Return). A return gives back the same share of the price, discount and tax, and puts the goods back as chosen." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search returns" placeholder="Credit note or bill number" value={text} onChange={(event) => setText(event.target.value)} />
        {canReprint && <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>}
      </div>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Returns">
        <thead><tr><th>Credit note</th><th>Date</th><th>Bill</th><th>Customer</th><th className="num">Value</th><th className="num">Refunded</th><th className="num">To account</th><th /></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td>{row.number}</td><td>{dateOf(row.postedAt)}</td><td>{row.invoiceNumber ?? <span className="muted">no bill</span>}</td><td>{row.customerName ?? ""}</td>
            <td className="num">{formatPkr(row.totalPaisa)}</td>
            <td className="num">{row.refundPaisa > 0 ? `${formatPkr(row.refundPaisa)} (${row.refundMethodName})` : ""}</td>
            <td className="num">{row.accountCreditPaisa > 0 ? formatPkr(row.accountCreditPaisa) : ""}</td>
            <td className="action-cell">{canReprint && <button className="text-button" disabled={Boolean(busy) || !setup.data} onClick={() => void reprint(row.id)}>{busy === row.id ? "…" : "Reprint"}</button>}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={8} className="muted">No returns yet. Take goods back from the till with the Return button.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "return" : "returns"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
      {maySell && <p><Link className="text-button" to="/pos">Go to the till</Link></p>}
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
