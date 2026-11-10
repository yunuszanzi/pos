import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { createExpenseCategory, getAllExpenseCategories, getAllExpenses, updateExpenseCategory } from "../../api/accountsApi";
import { ErrorMessage, Field, PageTitle, SelectInput, TextInput } from "../../app/FormElements";
import { useCan } from "../../app/permissions";
import { dayText } from "../purchasing/dayText";

const pageSize = 25;

/** Money spent: filter by dates and category, see the total, and keep the categories. */
export function ExpensesPage() {
  const queryClient = useQueryClient();
  const mayCreate = useCan("expenses.create");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [hideReversed, setHideReversed] = useState(false);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [newCategory, setNewCategory] = useState("");
  const [categoryError, setCategoryError] = useState("");

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);

  const categories = useQuery({ queryKey: ["expense-categories"], queryFn: getAllExpenseCategories, staleTime: 60_000 });
  const list = useQuery({
    queryKey: ["expenses", { from, to, categoryId, hideReversed, search, page }],
    queryFn: ({ signal }) => getAllExpenses({ from, to, categoryId, q: search, reversed: hideReversed ? "hide" : "", page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const all = categories.data?.data ?? [];

  async function addCategory() {
    setCategoryError("");
    if (!newCategory.trim()) return;
    try {
      await createExpenseCategory(newCategory.trim());
      setNewCategory("");
      await queryClient.invalidateQueries({ queryKey: ["expense-categories"] });
    } catch (caught) {
      setCategoryError(caught instanceof Error ? caught.message : "Could not add the category");
    }
  }
  async function toggle(category: { id: string; name: string; active: boolean }) {
    setCategoryError("");
    try {
      await updateExpenseCategory(category.id, { name: category.name, active: !category.active });
      await queryClient.invalidateQueries({ queryKey: ["expense-categories"] });
    } catch (caught) {
      setCategoryError(caught instanceof Error ? caught.message : "Could not change the category");
    }
  }

  return <div className="content">
    <PageTitle title="Expenses" description="Money spent, from an account or from the register. An expense is never edited; if one is wrong, reverse it and record the right one." />
    <section className="panel stack">
      <div className="form-grid">
        <Field label="From"><TextInput type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
        <Field label="To"><TextInput type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
        <Field label="Category">
          <SelectInput value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}>
            <option value="">All categories</option>
            {all.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </SelectInput>
        </Field>
        <Field label="Search"><TextInput aria-label="Search expenses" placeholder="Number, payee, reference or note" value={text} onChange={(event) => setText(event.target.value)} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={hideReversed} onChange={(event) => { setHideReversed(event.target.checked); setPage(1); }} /> Hide reversed expenses</label>
      {mayCreate && <div className="button-row"><Link className="button primary" to="/expenses/new">Record an expense</Link></div>}
      {list.isError && <ErrorMessage>{list.error.message}</ErrorMessage>}
      <div className="table-scroll"><table aria-label="Expenses">
        <thead><tr><th>Expense</th><th>Date</th><th>Category</th><th>Paid to</th><th>Paid from</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.id}>
            <td><Link className="text-button" to={`/expenses/${row.id}`}>{row.number}</Link>{row.reversed && <small className="block muted">Reversed</small>}{row.hasAttachment && <small className="block muted">Bill attached</small>}</td>
            <td>{dayText(row.expenseDate)}</td><td>{row.categoryName}</td><td>{row.payee}</td><td>{row.paidFrom === "register" ? "The register" : row.accountName}</td>
            <td className="num">{formatPkr(row.amountPaisa)}</td>
          </tr>)}
          {list.isSuccess && rows.length === 0 && <tr><td colSpan={6} className="muted">No expenses here.</td></tr>}
        </tbody>
        <tfoot><tr><th colSpan={5}>Spent in these results (reversed ones left out)</th><th className="num" data-testid="expenses-total">{formatPkr(list.data?.spentPaisa ?? 0)}</th></tr></tfoot>
      </table></div>
      <div className="button-row">
        <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page} of {pageCount} · {total} {total === 1 ? "expense" : "expenses"}</span>
        <button className="button secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>

    {mayCreate && <section className="panel stack" aria-label="Expense categories">
      <h2>Categories</h2>
      {categoryError && <ErrorMessage>{categoryError}</ErrorMessage>}
      <ul className="role-list">
        {all.map((category) => <li key={category.id}>
          <span><strong>{category.name}</strong>{!category.active && <small>Not in use</small>}</span>
          <button className="text-button" onClick={() => void toggle(category)}>{category.active ? "Stop using" : "Use again"}</button>
        </li>)}
      </ul>
      <div className="form-grid">
        <Field label="New category"><TextInput value={newCategory} maxLength={100} onChange={(event) => setNewCategory(event.target.value)} /></Field>
      </div>
      <div className="button-row"><button className="button secondary" onClick={() => void addCategory()} disabled={!newCategory.trim()}>Add category</button></div>
    </section>}
  </div>;
}
