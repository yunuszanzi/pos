import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatPkr, toPlainRupees } from "../../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat } from "../../../shared/receipt";
import { getSupplierOpenBills, postSupplierPayment, type SupplierPayment } from "../../api/suppliersApi";
import { ErrorMessage, Field, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { amountOf } from "../../pos/amounts";
import { Dialog } from "../../pos/Dialog";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";
import { dayText } from "../purchasing/dayText";
import type { PrintSetup } from "../purchasing/usePrintSetup";

/**
 * Pays a supplier. The oldest bills are settled first; ticking bills settles those instead, in order, until the money runs out.
 * Anything left over stays on the account as an advance. Cash comes out of the open shift of the terminal being used.
 */
export function PaySupplierDialog({ supplier, owedPaisa, setup, onClose, onPosted }: {
  supplier: { id: string; name: string }; owedPaisa: number; setup: PrintSetup; onClose: () => void; onPosted?: (payment: SupplierPayment) => void;
}) {
  const queryClient = useQueryClient();
  const bills = useQuery({ queryKey: ["supplier-open-bills", supplier.id], queryFn: ({ signal }) => getSupplierOpenBills(supplier.id, signal), staleTime: 0 });
  // Not cash to begin with: cash needs a till with an open shift, and most supplier payments are transfers or cheques.
  const first = setup.paymentMethods.find((method) => method.kind !== "cash") ?? setup.paymentMethods[0];
  const [methodId, setMethodId] = useState(first?.id ?? "");
  const [amount, setAmount] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<SupplierPayment | null>(null);
  const [format, setFormat] = useState<PrintFormat>(setup.defaultFormat);
  const [job, setJob] = useState<PrintJob | null>(null);
  const key = useRef(`supplier-payment-${crypto.randomUUID()}`);

  // Until something is typed, the box offers everything that is owed.
  const shown = amount ?? (owedPaisa > 0 ? toPlainRupees(owedPaisa) : "");
  const amountPaisa = amountOf(shown);
  const method = setup.paymentMethods.find((row) => row.id === methodId);

  const voucher = (payment: SupplierPayment): PrintJob => ({
    business: setup.business, dateFormat: setup.dateFormat, timezone: setup.timezone, format,
    supplierPayment: {
      number: payment.number, postedAt: payment.postedAt, paidBy: payment.paidBy, branchName: payment.branchName, supplierName: payment.supplierName, methodName: payment.methodName,
      amountPaisa: payment.amountPaisa, reference: payment.reference, note: payment.note, allocations: payment.allocations, supplierBalancePaisa: payment.supplierBalancePaisa,
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!bills.data || !amountPaisa || amountPaisa <= 0) return setError("Enter the amount paid, for example 15000.00");
    setBusy(true);
    setError("");
    try {
      let allocations: Array<{ billId: string; amountPaisa: number }> | undefined;
      if (picked.length) {
        let left = amountPaisa;
        allocations = [];
        for (const bill of bills.data.filter((row) => picked.includes(row.billId))) {
          const take = Math.min(left, bill.outstandingPaisa);
          if (take > 0) allocations.push({ billId: bill.billId, amountPaisa: take });
          left -= take;
        }
      }
      const payment = await postSupplierPayment({ supplierId: supplier.id, methodId, amountPaisa, reference, note, ...(allocations ? { allocations } : {}) }, key.current);
      await Promise.all(["supplier-ledger", "supplier-open-bills", "suppliers", "supplier-ageing", "supplier-payments", "purchase-bills", "purchase-bill"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      onPosted?.(payment);
      setPosted(payment);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The payment could not be recorded");
      setBusy(false);
    }
  }

  if (posted) {
    return <Dialog title="Payment made" onClose={onClose}><div className="stack">
      <p className="eyebrow">{posted.number}</p>
      <dl className="totals">
        <div className="grand"><dt>Paid</dt><dd data-testid="supplier-paid">{formatPkr(posted.amountPaisa)}</dd></div>
        {posted.allocations.map((row) => <div key={row.billId}><dt>Against {row.supplierInvoiceNo}</dt><dd>{formatPkr(row.amountPaisa)}</dd></div>)}
        <div><dt>{posted.supplierBalancePaisa < 0 ? "Advance held with them" : "Still owed"}</dt><dd data-testid="supplier-owed-after">{formatPkr(Math.abs(posted.supplierBalancePaisa))}</dd></div>
      </dl>
      <div className="pay-row">
        <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={() => setJob(voucher(posted))}>Print voucher</button>
      </div>
      <button className="button primary" onClick={onClose} autoFocus>Done</button>
      <ReceiptPrinter job={job} onDone={() => setJob(null)} />
    </div></Dialog>;
  }

  return <Dialog title="Pay supplier" onClose={() => { if (!busy) onClose(); }}>
    <form className="stack" onSubmit={submit}>
      <div className="pay-total"><span>{supplier.name} {owedPaisa < 0 ? "holds an advance of" : "is owed"}</span><strong data-testid="supplier-owed">{formatPkr(Math.abs(owedPaisa))}</strong></div>
      {bills.isPending && <p className="muted">Loading the bills…</p>}
      {bills.isError && <ErrorMessage>{bills.error.message}</ErrorMessage>}
      <Field label="Method"><SelectInput value={methodId} onChange={(event) => setMethodId(event.target.value)}>
        {setup.paymentMethods.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
      </SelectInput></Field>
      <Field label="Amount paid (Rs)"><MoneyInput value={shown} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setAmount(event.target.value)} /></Field>
      {method && method.kind !== "cash" && <Field label="Reference (transfer or cheque number)"><TextInput value={reference} maxLength={100} onChange={(event) => setReference(event.target.value)} /></Field>}
      <Field label="Note (optional)"><TextInput value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></Field>
      {bills.data && bills.data.length > 0 && <fieldset className="stack">
        <legend>Settle which bills? (none ticked: oldest first)</legend>
        {bills.data.map((bill) => <label key={bill.billId} className="checkbox-row">
          <input type="checkbox" checked={picked.includes(bill.billId)}
            onChange={(event) => setPicked((current) => (event.target.checked ? [...current, bill.billId] : current.filter((id) => id !== bill.billId)))} />
          <span>{bill.supplierInvoiceNo} ({bill.number}) · owes {formatPkr(bill.outstandingPaisa)} · due {dayText(bill.dueDate)}{bill.overdue ? " · overdue" : ""}</span>
        </label>)}
      </fieldset>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <button className="button primary" disabled={busy || !bills.data || !amountPaisa}>{busy ? "Recording…" : `Pay ${amountPaisa ? formatPkr(amountPaisa) : ""}`.trim()}</button>
    </form>
  </Dialog>;
}
