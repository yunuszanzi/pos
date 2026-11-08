import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { formatPkr } from "../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat } from "../../shared/receipt";
import { getAllSales } from "../api/posApi";
import { ErrorMessage, SelectInput, TextInput } from "../app/FormElements";
import { Dialog } from "./Dialog";
import { usePos } from "./pos-context";

const pageSize = 8;

/** Recent sales for finding a bill again and reprinting it. The search waits for a pause in typing and drops answers that arrive late. */
export function SalesHistoryDialog({ onClose, onReprint }: { onClose: () => void; onReprint: (saleId: string, format: PrintFormat) => Promise<void> }) {
  const { data, can } = usePos();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [format, setFormat] = useState<PrintFormat>(data.terminal.defaultPrintFormat);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({
    queryKey: ["sales-history", search, page],
    queryFn: ({ signal }) => getAllSales({ q: search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  const pageCount = Math.max(1, Math.ceil((list.data?.total ?? 0) / pageSize));

  async function reprint(id: string) {
    setBusy(id);
    setError("");
    try {
      await onReprint(id, format);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reprint the sale");
    } finally {
      setBusy("");
    }
  }

  return <Dialog title="Recent sales" onClose={onClose} wide><div className="stack">
    <div className="pay-row">
      <TextInput aria-label="Find a sale by number" placeholder="Bill number, for example 000042" value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
        {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
      </SelectInput>
    </div>
    {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <table className="report-table" aria-label="Sales">
      <tbody>
        {list.data?.data.map((sale) => <tr key={sale.id}>
          <td>{sale.number}<small className="block muted">{new Date(sale.postedAt).toLocaleString()} · {sale.cashierName}</small></td>
          <td className="num">{formatPkr(sale.totalPaisa)}</td>
          <td className="num">{can("sales.reprint") && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void reprint(sale.id)}>{busy === sale.id ? "…" : "Reprint"}</button>}</td>
        </tr>)}
        {list.data?.data.length === 0 && <tr><td colSpan={3} className="muted">No sales found.</td></tr>}
      </tbody>
    </table>
    <div className="button-row">
      <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
      <span className="muted">Page {page} of {pageCount}</span>
      <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
    </div>
  </div></Dialog>;
}
