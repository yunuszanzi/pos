import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatPkr, toPlainRupees } from "../../../shared/money";
import { printFormatLabels, printFormats, type PrintFormat, type ReceiptBusiness } from "../../../shared/receipt";
import { getCustomerLedger, postCustomerPayment, type CustomerPayment } from "../../api/customersApi";
import { ErrorMessage, Field, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { amountOf } from "../../pos/amounts";
import { Dialog } from "../../pos/Dialog";
import { ReceiptPrinter, type PrintJob } from "../../pos/Receipt";

export type PaymentPrintSetup = { business: ReceiptBusiness; dateFormat: string; timezone: string; defaultFormat: PrintFormat };
type Method = { id: string; name: string; kind: string };

/**
 * Takes money from a customer against their khata. The oldest invoices are settled first; ticking invoices settles those
 * instead, in order, until the money runs out. Anything left over stays on the account as credit.
 */
export function ReceivePaymentDialog({ customerId, methods, print, onClose, onPosted }: {
  customerId: string; methods: Method[]; print: PaymentPrintSetup; onClose: () => void; onPosted?: (payment: CustomerPayment) => void;
}) {
  const queryClient = useQueryClient();
  const ledger = useQuery({ queryKey: ["customer-ledger", customerId, 1], queryFn: ({ signal }) => getCustomerLedger(customerId, 1, signal), staleTime: 0 });
  const cash = methods.find((method) => method.kind === "cash") ?? methods[0];
  const [methodId, setMethodId] = useState(cash?.id ?? "");
  const [amount, setAmount] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<CustomerPayment | null>(null);
  const [format, setFormat] = useState<PrintFormat>(print.defaultFormat);
  const [job, setJob] = useState<PrintJob | null>(null);
  const key = useRef(`customer-payment-${crypto.randomUUID()}`);

  const data = ledger.data;
  const owed = data ? Math.max(data.customer.balancePaisa, 0) : 0;
  // Until the cashier types something, the box offers everything the customer owes.
  const shown = amount ?? (owed > 0 ? toPlainRupees(owed) : "");
  const amountPaisa = amountOf(shown);
  const method = methods.find((row) => row.id === methodId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!data || !amountPaisa || amountPaisa <= 0) return setError("Enter the amount received, for example 1500.00");
    setBusy(true);
    setError("");
    try {
      let allocations: Array<{ invoiceId: string; amountPaisa: number }> | undefined;
      if (picked.length) {
        let left = amountPaisa;
        allocations = [];
        for (const invoice of data.openInvoices.filter((row) => picked.includes(row.invoiceId))) {
          const take = Math.min(left, invoice.outstandingPaisa);
          if (take > 0) allocations.push({ invoiceId: invoice.invoiceId, amountPaisa: take });
          left -= take;
        }
      }
      const payment = await postCustomerPayment({ customerId, methodId, amountPaisa, reference, note, ...(allocations ? { allocations } : {}) }, key.current);
      await queryClient.invalidateQueries({ queryKey: ["customer-ledger", customerId] });
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
      onPosted?.(payment);
      setPosted(payment);
      setJob({ ...print, format, payment });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The payment could not be recorded");
      setBusy(false);
    }
  }

  if (posted) {
    return <Dialog title="Payment received" onClose={onClose}><div className="stack">
      <p className="eyebrow">{posted.number}</p>
      <dl className="totals">
        <div className="grand"><dt>Received</dt><dd data-testid="payment-received">{formatPkr(posted.amountPaisa)}</dd></div>
        {posted.allocations.map((row) => <div key={row.invoiceId}><dt>Against {row.number}</dt><dd>{formatPkr(row.amountPaisa)}</dd></div>)}
        <div><dt>{posted.customerBalancePaisa < 0 ? "Credit on account" : "Still owed"}</dt><dd data-testid="payment-balance">{formatPkr(Math.abs(posted.customerBalancePaisa))}</dd></div>
      </dl>
      <div className="pay-row">
        <SelectInput aria-label="Print format" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
          {printFormats.map((value) => <option key={value} value={value}>{printFormatLabels[value]}</option>)}
        </SelectInput>
        <button className="button secondary" onClick={() => setJob({ ...print, format, payment: posted, duplicate: { copyNumber: 2 } })}>Print again</button>
      </div>
      <button className="button primary" onClick={onClose} autoFocus>Done</button>
      <ReceiptPrinter job={job} onDone={() => setJob(null)} />
    </div></Dialog>;
  }

  return <Dialog title="Receive payment" onClose={() => { if (!busy) onClose(); }}>
    <form className="stack" onSubmit={submit}>
      {ledger.isPending && <p className="muted">Loading the account…</p>}
      {ledger.isError && <ErrorMessage>{ledger.error.message}</ErrorMessage>}
      {data && <>
        <div className="pay-total"><span>{data.customer.name} {data.customer.balancePaisa < 0 ? "has credit of" : "owes"}</span><strong data-testid="payment-owed">{formatPkr(Math.abs(data.customer.balancePaisa))}</strong></div>
        <Field label="Method"><SelectInput value={methodId} onChange={(event) => setMethodId(event.target.value)}>
          {methods.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </SelectInput></Field>
        <Field label="Amount received (Rs)"><MoneyInput value={shown} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setAmount(event.target.value)} /></Field>
        {method && method.kind !== "cash" && <Field label="Reference"><TextInput value={reference} maxLength={100} onChange={(event) => setReference(event.target.value)} /></Field>}
        <Field label="Note (optional)"><TextInput value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></Field>
        {data.openInvoices.length > 0 && <fieldset className="stack">
          <legend>Settle which invoices? (none ticked: oldest first)</legend>
          {data.openInvoices.map((invoice) => <label key={invoice.invoiceId} className="checkbox-row">
            <input type="checkbox" checked={picked.includes(invoice.invoiceId)}
              onChange={(event) => setPicked((current) => (event.target.checked ? [...current, invoice.invoiceId] : current.filter((id) => id !== invoice.invoiceId)))} />
            <span>{invoice.number} · owes {formatPkr(invoice.outstandingPaisa)}{invoice.overdue ? " · overdue" : ""}</span>
          </label>)}
        </fieldset>}
      </>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <button className="button primary" disabled={busy || !data || !amountPaisa}>{busy ? "Recording…" : `Receive ${amountPaisa ? formatPkr(amountPaisa) : "payment"}`}</button>
    </form>
  </Dialog>;
}
