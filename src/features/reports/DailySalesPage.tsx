import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatPkr } from "../../../shared/money";
import { getDailySalesReport } from "../../api/posApi";
import { ErrorMessage, Field, PageTitle, TextInput } from "../../app/FormElements";

/** Today in Karachi, as yyyy-mm-dd. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

export function DailySalesPage() {
  const [date, setDate] = useState(today);
  const report = useQuery({ queryKey: ["daily-sales", date], queryFn: () => getDailySalesReport(date), enabled: Boolean(date), staleTime: 0 });
  const data = report.data;

  return <div className="content">
    <PageTitle title="Daily sales" description="Everything sold on one day, in Karachi time." />
    <div className="stack">
      <section className="panel"><Field label="Day"><TextInput type="date" value={date} max={today()} onChange={(event) => setDate(event.target.value)} /></Field></section>
      {report.isError && <ErrorMessage>{report.error.message}</ErrorMessage>}
      {report.isPending && <p className="muted">Loading…</p>}
      {data && <>
        <div className="dashboard-grid">
          <div className="dashboard-card"><small>Sales</small><strong data-testid="report-total">{formatPkr(data.totalPaisa)}</strong><small>{data.invoiceCount} {data.invoiceCount === 1 ? "bill" : "bills"}</small></div>
          <div className="dashboard-card"><small>Tax in sales</small><strong>{formatPkr(data.taxPaisa)}</strong><small>Discounts given {formatPkr(data.discountPaisa)}</small></div>
          {data.profitPaisa !== undefined && data.costPaisa !== undefined
            ? <div className="dashboard-card"><small>Profit before expenses</small><strong data-testid="report-profit">{formatPkr(data.profitPaisa)}</strong><small>Cost of goods {formatPkr(data.costPaisa)}</small></div>
            : <div className="dashboard-card"><small>Gross sales</small><strong>{formatPkr(data.grossPaisa)}</strong><small>Before discounts</small></div>}
        </div>
        <div className="two-column">
          <section className="panel"><h2>Payments</h2>
            <table className="report-table" aria-label="Payments by method"><tbody>
              {data.byMethod.map((row) => <tr key={row.code}><td>{row.name}</td><td>{row.payments} {row.payments === 1 ? "payment" : "payments"}</td><td className="num">{formatPkr(row.amountPaisa)}</td></tr>)}
              {data.byMethod.length === 0 && <tr><td className="muted">No payments on this day.</td></tr>}
            </tbody></table>
          </section>
          <section className="panel"><h2>By cashier</h2>
            <table className="report-table" aria-label="Sales by cashier"><tbody>
              {data.byCashier.map((row) => <tr key={row.name ?? "unknown"}><td>{row.name ?? "Unknown"}</td><td>{row.invoiceCount} {row.invoiceCount === 1 ? "bill" : "bills"}</td><td className="num">{formatPkr(row.totalPaisa)}</td></tr>)}
              {data.byCashier.length === 0 && <tr><td className="muted">No sales on this day.</td></tr>}
            </tbody></table>
          </section>
        </div>
        <section className="panel"><h2>Best sellers</h2>
          <table className="report-table" aria-label="Best sellers"><tbody>
            {data.topProducts.map((row) => <tr key={row.sku}><td>{row.productName}<small className="block muted">{row.sku}</small></td><td className="num">{row.quantityBase}</td><td className="num">{formatPkr(row.totalPaisa)}</td></tr>)}
            {data.topProducts.length === 0 && <tr><td className="muted">Nothing sold on this day.</td></tr>}
          </tbody></table>
        </section>
      </>}
    </div>
  </div>;
}
