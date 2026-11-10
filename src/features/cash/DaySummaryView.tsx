import { formatPkr } from "../../../shared/money";
import type { DaySummary } from "../../api/dayClosingApi";
import { momentDayText } from "../purchasing/dayText";

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit" }) : "still open");

/** A branch's day as written down: the shifts, what was sold, how it was paid and what was spent. */
export function DaySummaryView({ summary }: { summary: DaySummary }) {
  const variance = summary.cashVariancePaisa;
  return <div className="stack">
    <section className="panel stack" aria-label="Shifts">
      <h2>Shifts</h2>
      <div className="table-scroll"><table aria-label="Shifts of the day">
        <thead><tr><th>Terminal</th><th>Opened by</th><th>Opened</th><th>Closed</th><th className="num">Float</th><th className="num">Expected cash</th><th className="num">Counted</th><th className="num">Difference</th></tr></thead>
        <tbody>
          {summary.shifts.map((shift) => <tr key={shift.id}>
            <td>{shift.terminal}</td><td>{shift.openedBy}</td><td>{momentDayText(shift.openedAt)} {time(shift.openedAt)}</td><td>{time(shift.closedAt)}</td>
            <td className="num">{formatPkr(shift.openingFloatPaisa)}</td>
            <td className="num">{shift.expectedPaisa === null ? "" : formatPkr(shift.expectedPaisa)}</td>
            <td className="num">{shift.countedPaisa === null ? "" : formatPkr(shift.countedPaisa)}</td>
            <td className="num">{shift.variancePaisa === null ? "" : formatPkr(shift.variancePaisa)}</td>
          </tr>)}
          {summary.shifts.length === 0 && <tr><td colSpan={8} className="muted">No shift was opened this day.</td></tr>}
        </tbody>
        {summary.shifts.length > 0 && <tfoot><tr><th colSpan={7}>Cash difference over all shifts</th><th className="num" data-testid="cash-variance">{formatPkr(variance)}</th></tr></tfoot>}
      </table></div>
    </section>

    <div className="dashboard-grid">
      <div className="dashboard-card"><small>Sales</small><strong data-testid="day-sales">{formatPkr(summary.sales.totalPaisa)}</strong>
        <small>{summary.sales.bills} {summary.sales.bills === 1 ? "bill" : "bills"}{summary.sales.deskBills ? `, ${summary.sales.deskBills} from the desk` : ""}</small></div>
      <div className="dashboard-card"><small>Tax · Discounts · On credit</small><strong>{formatPkr(summary.sales.taxPaisa)}</strong>
        <small>Discounts {formatPkr(summary.sales.discountPaisa)} · credit {formatPkr(summary.sales.creditPaisa)}</small></div>
      <div className="dashboard-card"><small>Returns</small><strong>{formatPkr(summary.returns.totalPaisa)}</strong>
        <small>{summary.returns.count} {summary.returns.count === 1 ? "return" : "returns"} · refunded {formatPkr(summary.returns.refundedPaisa)}</small></div>
      <div className="dashboard-card"><small>Expenses</small><strong data-testid="day-expenses">{formatPkr(summary.expenses.totalPaisa)}</strong>
        <small>{summary.expenses.count} {summary.expenses.count === 1 ? "expense" : "expenses"}</small></div>
    </div>

    <div className="two-column">
      <section className="panel stack" aria-label="Money by method"><h2>Money by method</h2>
        <div className="table-scroll"><table aria-label="Money by method">
          <thead><tr><th>Method</th><th className="num">Sales</th><th className="num">From customers</th><th className="num">Paid to suppliers</th><th className="num">Refunds</th></tr></thead>
          <tbody>
            {summary.byMethod.map((row) => <tr key={row.method}><td>{row.method}</td><td className="num">{formatPkr(row.salesPaisa)}</td><td className="num">{formatPkr(row.receiptsPaisa)}</td><td className="num">{formatPkr(row.paidOutPaisa)}</td><td className="num">{formatPkr(row.refundsPaisa)}</td></tr>)}
            {summary.byMethod.length === 0 && <tr><td colSpan={5} className="muted">No money moved.</td></tr>}
          </tbody>
        </table></div>
      </section>
      <section className="panel stack" aria-label="Expenses by category"><h2>Expenses by category</h2>
        <table aria-label="Expenses by category">
          <thead><tr><th>Category</th><th className="num">Expenses</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {summary.expenses.byCategory.map((row) => <tr key={row.category}><td>{row.category}</td><td className="num">{row.expenses}</td><td className="num">{formatPkr(row.amountPaisa)}</td></tr>)}
            {summary.expenses.byCategory.length === 0 && <tr><td colSpan={3} className="muted">Nothing was spent.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  </div>;
}
