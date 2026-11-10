import { useRef, useState, type FormEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { accountEntrySchema, accountKindLabels } from "../../../shared/schemas/accounts";
import { getAccountEntries, postAccountEntry, updateAccount } from "../../api/accountsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { useCan } from "../../app/permissions";
import { amountOf } from "../../pos/amounts";
import { dayText } from "../purchasing/dayText";

const docLabels: Record<string, string> = {
  opening: "Opening balance", deposit: "Deposit", withdrawal: "Withdrawal", transfer: "Transfer", expense: "Expense", expense_reversal: "Expense reversed",
  sales_payment: "Sale", customer_payment: "Customer payment", supplier_payment: "Supplier payment", sales_refund: "Refund",
};

/** One account's book: every entry with the balance after it. */
export function AccountPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const mayManage = useCan("accounts.manage");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const book = useQuery({ queryKey: ["account-entries", id, { from, to, page }], queryFn: ({ signal }) => getAccountEntries(id, { from, to, page }, signal), placeholderData: keepPreviousData });

  const [direction, setDirection] = useState<"deposit" | "withdrawal">("deposit");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const entryKey = useRef(`acc-${crypto.randomUUID()}`);

  if (book.isPending) return <div className="content"><p className="muted">Loading…</p></div>;
  if (book.isError) return <div className="content"><ErrorMessage>{book.error.message}</ErrorMessage></div>;
  const account = book.data.account;
  const pageCount = Math.max(1, Math.ceil(book.data.total / book.data.pageSize));

  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const amountPaisa = amountOf(amount);
    if (amountPaisa === null || amountPaisa === 0) return setError("Enter an amount more than zero, in rupees with up to two decimals.");
    const input = { direction, amountPaisa, memo };
    const checked = accountEntrySchema.safeParse(input);
    if (!checked.success) return setError(checked.error.issues[0].message);
    setBusy(true);
    try {
      await postAccountEntry(id, input, entryKey.current);
      entryKey.current = `acc-${crypto.randomUUID()}`;
      setAmount(""); setMemo("");
      setNotice(direction === "deposit" ? "Deposit recorded." : "Withdrawal recorded.");
      await Promise.all(["accounts", "account-entries"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record the entry");
      entryKey.current = `acc-${crypto.randomUUID()}`;
    } finally {
      setBusy(false);
    }
  }

  async function setActive(active: boolean) {
    setBusy(true);
    setError("");
    try {
      await updateAccount(id, { name: account.name, active });
      await Promise.all(["accounts", "account-entries"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the account");
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title={account.name} description={`${accountKindLabels[account.kind]}${account.methods.length ? `, receives ${account.methods.join(", ")}` : ""}.`} />
    <p><Link className="text-button" to="/accounts">← Back to accounts</Link></p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    <section className="panel stack">
      <dl className="totals"><div className="grand"><dt>Balance</dt><dd data-testid="account-balance">{formatPkr(account.balancePaisa)}</dd></div></dl>
      {mayManage && <div className="button-row"><button className="button secondary" disabled={busy} onClick={() => void setActive(!account.active)}>{account.active ? "Stop using this account" : "Use this account again"}</button></div>}
    </section>

    {mayManage && account.active && <section className="panel stack" aria-label="Record a deposit or withdrawal">
      <h2>Record a deposit or withdrawal</h2>
      <p className="muted">For money that is not a transfer or an expense: a cheque that cleared, a bank charge, interest.</p>
      <form className="stack" onSubmit={(event) => void record(event)}>
        <div className="form-grid">
          <Field label="What happened"><SelectInput value={direction} onChange={(event) => setDirection(event.target.value as "deposit" | "withdrawal")}><option value="deposit">Money in (deposit)</option><option value="withdrawal">Money out (withdrawal)</option></SelectInput></Field>
          <Field label="Amount (Rs)"><MoneyInput value={amount} onChange={(event) => setAmount(event.target.value)} required /></Field>
          <Field label="What is it for"><TextInput value={memo} maxLength={300} onChange={(event) => setMemo(event.target.value)} required /></Field>
        </div>
        <div className="button-row"><button className="button primary" disabled={busy}>Record</button></div>
      </form>
    </section>}

    <section className="panel stack">
      <h2>Entries</h2>
      <div className="form-grid">
        <Field label="From"><TextInput type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
        <Field label="To"><TextInput type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
      </div>
      <div className="table-scroll"><table aria-label="Account entries">
        <thead><tr><th>Date</th><th>What</th><th>Document</th><th>Note</th><th className="num">In</th><th className="num">Out</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {book.data.data.map((entry) => <tr key={entry.id}>
            <td>{dayText(entry.entryDate)}</td><td>{docLabels[entry.docType] ?? entry.docType}</td><td>{entry.docNumber}</td><td>{entry.memo}</td>
            <td className="num">{entry.amountPaisa > 0 ? formatPkr(entry.amountPaisa) : ""}</td><td className="num">{entry.amountPaisa < 0 ? formatPkr(-entry.amountPaisa) : ""}</td>
            <td className="num">{formatPkr(entry.runningPaisa)}</td>
          </tr>)}
          {book.data.data.length === 0 && <tr><td colSpan={7} className="muted">No entries{from || to ? " in these dates" : " yet"}.</td></tr>}
        </tbody>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {book.data.total} {book.data.total === 1 ? "entry" : "entries"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  </div>;
}
