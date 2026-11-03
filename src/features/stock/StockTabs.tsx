import { NavLink } from "react-router-dom";
import { useCan } from "../../app/permissions";

/** Links between the stock screens, shown only for the ones the user may open. */
export function StockTabs() {
  const canValue = useCan("products.cost.view");
  const canOpen = useCan("inventory.opening_stock");
  const tabs = [
    { to: "/stock", label: "Stock levels", show: true },
    { to: "/stock/adjustments", label: "Adjustments", show: true },
    { to: "/stock/valuation", label: "Valuation", show: canValue },
    { to: "/stock/opening", label: "Opening stock", show: canOpen },
  ];
  return <nav className="button-row" aria-label="Stock sections">
    {tabs.filter((tab) => tab.show).map((tab) => <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => isActive ? "button primary" : "button secondary"}>{tab.label}</NavLink>)}
  </nav>;
}
