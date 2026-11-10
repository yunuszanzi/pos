import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { businessToday } from "../../../shared/dates";
import { expenseSchema } from "../../../shared/schemas/accounts";
import { attachExpenseBill, getAllAccounts, getAllExpenseCategories, postExpense } from "../../api/accountsApi";
import { getCurrentShift } from "../../api/posApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { useCan } from "../../app/permissions";
import { amountOf } from "../../pos/amounts";

const REGISTER = "register";
const today = () => businessToday();

/** Records an expense: what for, how much, who was paid, where the money came from, and a photo of the bill. */
export function ExpenseFormPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayShift = useCan("shifts.open");
  const mayAccounts = useCan("accounts.view");
  const categories = useQuery({ queryKey: ["expense-categories"], queryFn: getAllExpenseCategories, staleTime: 60_000 });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAllAccounts, enabled: mayAccounts });
  const shift = useQuery({ queryKey: ["current-shift"], queryFn: getCurrentShift, enabled: mayShift });
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(today());
  const [paidFrom, setPaidFrom] = useState("");
  const [payee, setPayee] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for this expense, so a retry after a dropped connection cannot record it twice.
  const key = useRef(`exp-${crypto.randomUUID()}`);

  const usable = (categories.data?.data ?? []).filter((category) => category.active);
  const openShift = shift.data?.status === "open" ? shift.data : null;
  const activeAccounts = (accounts.data?.data ?? []).filter((account) => account.active);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const amountPaisa = amountOf(amount);
    if (amountPaisa === null || amountPaisa === 0) return setError("Enter the amount in rupees, with up to two decimals, more than zero.");
    if (!paidFrom) return setError("Choose where the money came from");
    const input = {
      categoryId, amountPaisa, expenseDate, payee, reference, note,
      ...(paidFrom === REGISTER ? { paidFrom: "register" as const, shiftId: openShift?.id } : { paidFrom: "account" as const, accountId: paidFrom }),
    };
    const checked = expenseSchema.safeParse(input);
    if (!checked.success) return setError(checked.error.issues[0].message);
    setBusy(true);
    try {
      const saved = await postExpense(input, key.current);
      // The expense is recorded either way; if the photo fails, say so and let the person try again from the expense.
      if (file) {
        try {
          await attachExpenseBill(saved.id, file);
        } catch (caught) {
          await Promise.all(["expenses", "accounts", "current-shift"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
          navigate(`/expenses/${saved.id}?bill=failed&why=${encodeURIComponent(caught instanceof Error ? caught.message : "")}`);
          return;
        }
      }
      await Promise.all(["expenses", "accounts", "account-entries", "current-shift"].map((name) => queryClient.invalidateQueries({ queryKey: [name] })));
      navigate(`/expenses/${saved.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record the expense");
      key.current = `exp-${crypto.randomUUID()}`;
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="Record an expense" description="Choose the category and the amount, and say where the money came from. You can add a photo of the bill." />
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <section className="panel stack">
        <div className="form-grid">
          <Field label="Category">
            <SelectInput value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>
              <option value="">Choose…</option>
              {usable.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </SelectInput>
          </Field>
          <Field label="Amount (Rs)"><MoneyInput value={amount} onChange={(event) => setAmount(event.target.value)} required /></Field>
          <Field label="Date"><TextInput type="date" value={expenseDate} max={today()} onChange={(event) => setExpenseDate(event.target.value)} required /></Field>
          <Field label="Paid from">
            <SelectInput value={paidFrom} onChange={(event) => setPaidFrom(event.target.value)} required>
              <option value="">Choose…</option>
              {openShift && <option value={REGISTER}>The register (open shift)</option>}
              {activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </SelectInput>
          </Field>
          <Field label="Paid to"><TextInput value={payee} maxLength={200} onChange={(event) => setPayee(event.target.value)} /></Field>
          <Field label="Bill or cheque number"><TextInput value={reference} maxLength={100} onChange={(event) => setReference(event.target.value)} /></Field>
          <Field label="Note"><TextInput value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
          <Field label="Photo or PDF of the bill"><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field>
        </div>
        {!openShift && mayShift && <p className="muted">To pay from the register, open a shift at the till first.</p>}
      </section>
      <div className="button-row">
        <button className="button primary" disabled={busy || !categoryId}>{busy ? "Saving…" : "Record expense"}</button>
        <Link className="button secondary" to="/expenses">Cancel</Link>
      </div>
    </form>
  </div>;
}
