import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatPkr } from "../../../shared/money";
import { getDashboard } from "../../api/dashboardApi";
import { ErrorMessage } from "../../app/FormElements";

/** The shape of the last two weeks: one bar a day. The figures are in the title of each bar and in the label for a screen reader. */
function TrendChart({ points }: { points: Array<{ day: string; totalPaisa: number; bills: number }> }) {
  const width = 560;
  const height = 120;
  const gap = 6;
  const barWidth = (width - gap * (points.length - 1)) / points.length;
  const highest = Math.max(1, ...points.map((point) => point.totalPaisa));
  const best = points.reduce((a, b) => (b.totalPaisa > a.totalPaisa ? b : a), points[0]);
  return <svg className="trend-chart" viewBox={`0 0 ${width} ${height + 18}`} role="img" aria-label={`Sales for the last ${points.length} days. Best day ${best.day}: ${formatPkr(best.totalPaisa)}.`}>
    {points.map((point, index) => {
      // Only the bar's height is scaled; it is a picture, not an amount of money.
      const barHeight = point.totalPaisa === 0 ? 2 : Math.max(3, (point.totalPaisa / highest) * height);
      const x = index * (barWidth + gap);
      return <g key={point.day}>
        <rect x={x} y={height - barHeight} width={barWidth} height={barHeight} rx={2} className={point.totalPaisa === 0 ? "trend-bar empty" : "trend-bar"}>
          <title>{`${point.day}: ${formatPkr(point.totalPaisa)}, ${point.bills} ${point.bills === 1 ? "bill" : "bills"}`}</title>
        </rect>
        {(index === 0 || index === points.length - 1) && <text x={x + barWidth / 2} y={height + 14} textAnchor={index === 0 ? "start" : "end"} className="trend-label">{point.day.slice(5)}</text>}
      </g>;
    })}
  </svg>;
}

/** Today's numbers at a glance (FR-RPT-01). Every figure is there only if the person may see it; nothing is worked out in the browser. */
export function DashboardPanel() {
  const board = useQuery({ queryKey: ["dashboard"], queryFn: ({ signal }) => getDashboard(undefined, signal), staleTime: 30_000 });
  if (board.isPending) return <p className="muted">Loading today's numbers…</p>;
  if (board.isError) return <ErrorMessage>{board.error.message}</ErrorMessage>;
  const data = board.data;
  const nothing = !data.sales && !data.cash && !data.receivables && !data.payables && !data.lowStock && !data.fbr;
  if (nothing) return null;

  return <section className="stack" aria-label="Today at a glance">
    <div className="dashboard-grid">
      {data.sales && <div className="dashboard-card"><small>Sales today</small><strong data-testid="dash-sales">{formatPkr(data.sales.totalPaisa)}</strong>
        <small>{data.sales.bills} {data.sales.bills === 1 ? "bill" : "bills"} · average {formatPkr(data.sales.averageBillPaisa)}</small></div>}
      {data.profit && <div className="dashboard-card"><small>Profit today (before expenses)</small><strong data-testid="dash-profit">{formatPkr(data.profit.grossProfitPaisa)}</strong>
        <small>Net sales {formatPkr(data.profit.netSalesPaisa)} less cost {formatPkr(data.profit.costPaisa)}</small></div>}
      {data.sales && data.sales.returns > 0 && <div className="dashboard-card"><small>Returns today</small><strong>{formatPkr(data.sales.returnsPaisa)}</strong><small>{data.sales.returns} {data.sales.returns === 1 ? "return" : "returns"}</small></div>}
      {data.cash && <div className="dashboard-card"><small>Cash in hand</small>
        <strong data-testid="dash-cash">{formatPkr((data.cash.drawersPaisa ?? 0) + (data.cash.accountsPaisa ?? 0))}</strong>
        <small>{[data.cash.drawersPaisa !== undefined ? `${formatPkr(data.cash.drawersPaisa)} in ${data.cash.openShifts} open ${data.cash.openShifts === 1 ? "drawer" : "drawers"}` : "", data.cash.accountsPaisa !== undefined ? `${formatPkr(data.cash.accountsPaisa)} in accounts` : ""].filter(Boolean).join(" · ")}</small></div>}
      {data.receivables && <Link className="dashboard-card" to="/customer-ageing"><small>Customers owe</small><strong data-testid="dash-receivables">{formatPkr(data.receivables.totalPaisa)}</strong>
        <small>{data.receivables.customers} {data.receivables.customers === 1 ? "customer" : "customers"}</small></Link>}
      {data.payables && <Link className="dashboard-card" to="/supplier-ageing"><small>The shop owes suppliers</small><strong data-testid="dash-payables">{formatPkr(data.payables.totalPaisa)}</strong>
        <small>{data.payables.suppliers} {data.payables.suppliers === 1 ? "supplier" : "suppliers"}</small></Link>}
      {data.lowStock && <Link className="dashboard-card" to="/reports/low-stock"><small>Low stock</small><strong data-testid="dash-low-stock">{data.lowStock.items} {data.lowStock.items === 1 ? "item" : "items"}</strong>
        <small>At or below their reorder level</small></Link>}
      {data.fbr && <Link className="dashboard-card" to={data.fbr.rejected + data.fbr.failed > 0 ? "/fbr/log?attention=1" : "/fbr/log"}><small>FBR</small><strong data-testid="dash-fbr">{data.fbr.rejected + data.fbr.failed > 0 ? `${data.fbr.rejected + data.fbr.failed} need attention` : `${data.fbr.pending} waiting`}</strong>
        <small>{data.fbr.pending} waiting · {data.fbr.rejected} refused · {data.fbr.failed} given up</small></Link>}
    </div>
    {(data.trend || data.topProducts) && <div className="two-column">
      {data.trend && <section className="panel"><h2>Last {data.trend.length} days</h2><TrendChart points={data.trend} /></section>}
      {data.topProducts && <section className="panel"><h2>Best sellers today</h2>
        <table aria-label="Best sellers today"><thead><tr><th>Product</th><th className="num">Quantity</th><th className="num">Sales</th></tr></thead>
          <tbody>
            {data.topProducts.map((row) => <tr key={row.sku}><td>{row.product}<small className="block muted">{row.sku}</small></td><td className="num">{row.quantity}</td><td className="num">{formatPkr(row.totalPaisa)}</td></tr>)}
            {data.topProducts.length === 0 && <tr><td colSpan={3} className="muted">Nothing sold yet today.</td></tr>}
          </tbody></table>
      </section>}
    </div>}
  </section>;
}
