import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatPkr } from "../../../shared/money";
import { getAllCustomers, postCheque, type Cheque } from "../../api/customersApi";
import { ErrorMessage, Field, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { amountOf } from "../../pos/amounts";
import { Dialog } from "../../pos/Dialog";

/** Finds a customer by name or phone; waits for a pause in typing and drops answers to older searches. */
function CustomerPicker({ onPick }: { onPick: (customer: { id: string; name: string }) => void }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  const found = useQuery({
    queryKey: ["customers", { picker: search }], queryFn: ({ signal }) => getAllCustomers({ q: search, pageSize: 6 }, signal), enabled: search.length > 0,
  });
  return <div className="stack">
    <Field label="Customer"><TextInput aria-label="Find a customer" placeholder="Name or phone" autoFocus value={text} onChange={(event) => setText(event.target.value)} /></Field>
    {found.data?.data.map((customer) => <button type="button" key={customer.id} className="button secondary" onClick={() => onPick({ id: customer.id, name: customer.name })}>
      {customer.name}{customer.phone ? ` · ${customer.phone}` : ""}
    </button>)}
    {found.isSuccess && found.data.data.length === 0 && <p className="muted">No customer found.</p>}
  </div>;
}

/**
 * Takes a cheque from a customer. The amount is recorded as received straight away (the oldest invoices are settled), even for a
 * post-dated cheque; if the cheque bounces later, the amount goes back on the khata.
 */
export function ReceiveChequeDialog({ customer: given, onClose, onPosted }: {
  customer?: { id: string; name: string }; onClose: () => void; onPosted?: (cheque: Cheque) => void;
}) {
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState(given ?? null);
  const [chequeNo, setChequeNo] = useState("");
  const [bank, setBank] = useState("");
  const [amount, setAmount] = useState("");
  const [chequeDate, setChequeDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Cheque | null>(null);
  const key = useRef(`cheque-${crypto.randomUUID()}`);
  const amountPaisa = amountOf(amount);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!customer) return setError("Choose the customer");
    if (!amountPaisa || amountPaisa <= 0) return setError("Enter the cheque amount, for example 15000.00");
    setBusy(true);
    setError("");
    try {
      const cheque = await postCheque({ customerId: customer.id, chequeNo, bank, amountPaisa, chequeDate, note }, key.current);
      await Promise.all(["cheques", "customers", "customer-ledger", "customer-ageing", "customer-statement"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      onPosted?.(cheque);
      setDone(cheque);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The cheque could not be recorded");
      setBusy(false);
    }
  }

  if (done) {
    return <Dialog title="Cheque recorded" onClose={onClose}><div className="stack">
      <p>{done.bank} cheque {done.chequeNo} for <strong data-testid="cheque-recorded-amount">{formatPkr(done.amountPaisa)}</strong> from {done.customerName}, dated {done.chequeDate}.</p>
      <p className="muted">{done.customerBalancePaisa < 0 ? `${done.customerName} now has ${formatPkr(-done.customerBalancePaisa)} credit.` : `${done.customerName} now owes ${formatPkr(done.customerBalancePaisa)}.`} If it bounces, mark it bounced and the amount goes back on their khata.</p>
      <button className="button primary" onClick={onClose} autoFocus>Done</button>
    </div></Dialog>;
  }

  return <Dialog title="Receive a cheque" onClose={() => { if (!busy) onClose(); }}>
    <form className="stack" onSubmit={submit}>
      {customer
        ? <p>From <strong>{customer.name}</strong>{!given && <> <button type="button" className="text-button" onClick={() => setCustomer(null)}>change</button></>}</p>
        : <CustomerPicker onPick={setCustomer} />}
      <Field label="Cheque number"><TextInput value={chequeNo} maxLength={40} onChange={(event) => setChequeNo(event.target.value)} /></Field>
      <Field label="Bank"><TextInput value={bank} maxLength={100} onChange={(event) => setBank(event.target.value)} /></Field>
      <Field label="Amount (Rs)"><MoneyInput value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
      <Field label="Date on the cheque"><TextInput type="date" value={chequeDate} onChange={(event) => setChequeDate(event.target.value)} /></Field>
      <Field label="Note (optional)"><TextInput value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></Field>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <button className="button primary" disabled={busy || !customer || !chequeNo.trim() || !bank.trim() || !amountPaisa}>{busy ? "Recording…" : `Receive ${amountPaisa ? formatPkr(amountPaisa) : "cheque"}`}</button>
    </form>
  </Dialog>;
}
