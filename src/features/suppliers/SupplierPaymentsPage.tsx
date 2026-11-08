import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { formatPkr } from "../../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getAllSupplierPayments, getSupplierPaymentById } from "../../api/suppliersApi";
import { ErrorMessage, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { momentDayText } from "../purchasing/dayText";
import { usePrintSetup } from "../purchasing/usePrintSetup";

const pageSize = 25;

/** Money paid to suppliers, newest first. A voucher can be printed again at any time. */
export function SupplierPaymentsPage() {
  const setup = usePrintSetup();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [format, setFormat] = useState<PrintFormat | "">("");
  const [job, setJob] = useState<PrintJob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const list = useQuery({ queryKey: ["supplier-payments", { search, page }], queryFn: ({ signal }) => getAllSupplierPayments({ q: search, page, pageSize }, signal), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function print(id: string) {
    if (!setup) return;
    setBusy(id);
    setError("");
    try {
      const payment = await getSupplierPaymentById(id);
      setJob({
        business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format: format || setup.defaultFormat, duplicate: { copyNumber: 2 },
        supplierPayment: {
          number: payment.number, postedAt: payment.postedAt, paidBy: payment.paidBy, branchName: payment.branchName, supplierName: payment.supplierName, methodName: payment.methodName,
          amountPaisa: payment.amountPaisa, reference: payment.reference, note: payment.note, allocations: payment.allocations, supplierBalancePaisa: payment.supplierBalancePaisa,
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not print the voucher");
    } finally {
      setBusy("");
    }
  }

  return <div className="content">
    <PageTitle title="Payments made" description="Money paid to suppliers. Pay a supplier from their ledger page." />
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <section className="panel stack">
      <div className="form-grid">
        <TextInput aria-label="Search payments" placeholder="Voucher number, supplier or reference" value={text} onChange={(event) => setText(event.target.value)} />
        {setup && <SelectInput aria-label="Print format" value={format || setup.defaultFormat} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>}
      </div>
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Payments made">
        <thead><tr><th>Voucher</th><th>Date</th><th>Supplier</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td>{row.number}</td><td>{momentDayText(row.postedAt)}</td><td>{row.supplierName}</td><td>{row.methodName}</td><td>{row.reference}</td>
            <td className="num">{formatPkr(row.amountPaisa)}</td>
            <td className="action-cell">{setup && <button className="text-button" disabled={Boolean(busy)} onClick={() => void print(row.id)}>{busy === row.id ? "…" : "Reprint"}</button>}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={7} className="muted">No supplier has been paid yet.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "payment" : "payments"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
    <ReceiptPrinter job={job} onDone={() => setJob(null)} />
  </div>;
}
