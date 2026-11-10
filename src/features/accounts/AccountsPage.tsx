import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { accountKindLabels, accountKinds, accountSchema, accountTransferSchema, type AccountKind } from "../../../shared/schemas/accounts";
import { createAccount, getAllAccounts, getAllAccountTransfers, postAccountTransfer } from "../../api/accountsApi";
import { getCurrentShift } from "../../api/posApi";
import { ErrorMessage, Field, PageTitle, SelectInput, SuccessMessage, TextInput } from "../../app/FormElements";
import { MoneyInput } from "../../app/MoneyInput";
import { useCan } from "../../app/permissions";
import { amountOf } from "../../pos/amounts";
import { dayText } from "../purchasing/dayText";

const REGISTER = "register";

/** Where the shop's money is besides the till: cash boxes, bank accounts and wallets, what each holds, and moving money between them. */
export function AccountsPage() {
  const queryClient = useQueryClient();
  const mayManage = useCan("accounts.manage");
  const mayShift = useCan("shifts.open");
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAllAccounts });
  const transfers = useQuery({ queryKey: ["account-transfers", 1], queryFn: () => getAllAccountTransfers(1) });
  const shift = useQuery({ queryKey: ["current-shift"], queryFn: getCurrentShift, enabled: mayShift && mayManage });
  const [notice, setNotice] = useState("");

  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKind>("bank");
  const [opening, setOpening] = useState("");
  const [addError, setAddError] = useState("");

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [moveError, setMoveError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for each transfer being filled in, so a retry after a dropped connection cannot move the money twice.
  const transferKey = useRef(`trf-${crypto.randomUUID()}`);

  const list = accounts.data?.data ?? [];
  const active = list.filter((account) => account.active);
  const openShift = shift.data?.status === "open" ? shift.data : null;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError("");
    const openingBalancePaisa = opening.trim() === "" ? 0 : amountOf(opening);
    if (openingBalancePaisa === null) return setAddError("The opening balance is not a valid amount. Use rupees with up to two decimals.");
    const input = { name, kind, openingBalancePaisa };
    const checked = accountSchema.safeParse(input);
    if (!checked.success) return setAddError(checked.error.issues[0].message);
    setBusy(true);
    try {
      await createAccount(input);
      setName(""); setOpening("");
      setNotice(`Account "${name}" added.`);
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    } catch (caught) {
      setAddError(caught instanceof Error ? caught.message : "Could not add the account");
    } finally {
      setBusy(false);
    }
  }

  async function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMoveError("");
    const amountPaisa = amountOf(amount);
    if (amountPaisa === null || amountPaisa === 0) return setMoveError("Enter an amount more than zero, in rupees with up to two decimals.");
    const input = { ...(from === REGISTER ? { fromShiftId: openShift?.id } : { fromAccountId: from }), toAccountId: to, amountPaisa, memo };
    const checked = accountTransferSchema.safeParse(input);
    if (!checked.success) return setMoveError(checked.error.issues[0].message);
    setBusy(true);
    try {
      const result = await postAccountTransfer(input, transferKey.current);
      transferKey.current = `trf-${crypto.randomUUID()}`;
      setAmount(""); setMemo("");
      setNotice(`${result.transfer.number}: ${formatPkr(result.transfer.amountPaisa)} moved.`);
      await Promise.all(["accounts", "account-transfers", "account-entries", "current-shift"].map((queryName) => queryClient.invalidateQueries({ queryKey: [queryName] })));
    } catch (caught) {
      setMoveError(caught instanceof Error ? caught.message : "Could not move the money");
      transferKey.current = `trf-${crypto.randomUUID()}`;
    } finally {
      setBusy(false);
    }
  }

  return <div className="content">
    <PageTitle title="Accounts" description="Cash boxes, bank accounts and wallets. Money taken or paid by JazzCash, bank transfer and the like lands here by itself; the till drawer is counted at the end of each shift instead." />
    {notice && <SuccessMessage>{notice}</SuccessMessage>}
    {accounts.isError && <ErrorMessage>{accounts.error.message}</ErrorMessage>}
    <section className="panel stack">
      <div className="table-scroll"><table aria-label="Accounts">
        <thead><tr><th>Account</th><th>Kind</th><th>Receives</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {list.map((account) => <tr key={account.id}>
            <td><Link className="text-button" to={`/accounts/${account.id}`}>{account.name}</Link>{!account.active && <small className="block muted">Not in use</small>}</td>
            <td>{accountKindLabels[account.kind]}</td><td>{account.methods.join(", ")}</td><td className="num">{formatPkr(account.balancePaisa)}</td>
          </tr>)}
          {accounts.isSuccess && list.length === 0 && <tr><td colSpan={4} className="muted">No accounts yet.</td></tr>}
        </tbody>
        {list.length > 0 && <tfoot><tr><th colSpan={3}>In all accounts</th><th className="num" data-testid="accounts-total">{formatPkr(accounts.data?.totalPaisa ?? 0)}</th></tr></tfoot>}
      </table></div>
    </section>

    {mayManage && <section className="panel stack" aria-label="Move money">
      <h2>Move money</h2>
      {moveError && <ErrorMessage>{moveError}</ErrorMessage>}
      <form className="stack" onSubmit={(event) => void move(event)}>
        <div className="form-grid">
          <Field label="From">
            <SelectInput value={from} onChange={(event) => setFrom(event.target.value)} required>
              <option value="">Choose…</option>
              {openShift && <option value={REGISTER}>The register (open shift)</option>}
              {active.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </SelectInput>
          </Field>
          <Field label="To">
            <SelectInput value={to} onChange={(event) => setTo(event.target.value)} required>
              <option value="">Choose…</option>
              {active.filter((account) => account.id !== from).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </SelectInput>
          </Field>
          <Field label="Amount (Rs)"><MoneyInput value={amount} onChange={(event) => setAmount(event.target.value)} required /></Field>
          <Field label="Note"><TextInput value={memo} maxLength={300} onChange={(event) => setMemo(event.target.value)} /></Field>
        </div>
        <div className="button-row"><button className="button primary" disabled={busy || !from || !to}>Move money</button></div>
      </form>
      <p className="muted">Taking cash out of the register to the bank records a cash-out on the open shift, so the shift expects less cash.</p>
    </section>}

    {mayManage && <section className="panel stack" aria-label="Add an account">
      <h2>Add an account</h2>
      {addError && <ErrorMessage>{addError}</ErrorMessage>}
      <form className="stack" onSubmit={(event) => void add(event)}>
        <div className="form-grid">
          <Field label="Name"><TextInput value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required /></Field>
          <Field label="Kind"><SelectInput value={kind} onChange={(event) => setKind(event.target.value as AccountKind)}>{accountKinds.map((value) => <option key={value} value={value}>{accountKindLabels[value]}</option>)}</SelectInput></Field>
          <Field label="It holds today (Rs)"><MoneyInput value={opening} onChange={(event) => setOpening(event.target.value)} placeholder="0.00" /></Field>
        </div>
        <div className="button-row"><button className="button primary" disabled={busy}>Add account</button></div>
      </form>
    </section>}

    <section className="panel stack">
      <h2>Recent transfers</h2>
      <div className="table-scroll"><table aria-label="Transfers">
        <thead><tr><th>Transfer</th><th>Date</th><th>From</th><th>To</th><th>Note</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {(transfers.data?.data ?? []).map((row) => <tr key={row.id}>
            <td>{row.number}</td><td>{dayText(row.transferDate)}</td><td>{row.from}</td><td>{row.to}</td><td>{row.memo}</td><td className="num">{formatPkr(row.amountPaisa)}</td>
          </tr>)}
          {transfers.isSuccess && transfers.data.data.length === 0 && <tr><td colSpan={6} className="muted">Nothing has been moved yet.</td></tr>}
        </tbody>
      </table></div>
    </section>
  </div>;
}
