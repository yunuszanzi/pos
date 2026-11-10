import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getAllTerminals } from "../api/orgApi";
import { switchTerminalUser } from "../api/authApi";
import { useAuth } from "./useAuth";
import { useTerminalStore } from "./terminalStore";
import { ErrorMessage, Field, SelectInput, TextInput } from "./FormElements";
import { hasPermission } from "./permissions";
import { ErrorBoundary } from "./ErrorBoundary";
import { plannedModules } from "./plannedModules";

const AuditPage = lazy(() => import("../features/audit/AuditPage").then(({ AuditPage: Page }) => ({ default: Page })));
const LoginPage = lazy(() => import("../features/auth/LoginPage").then(({ LoginPage: Page }) => ({ default: Page })));
const OrganizationPage = lazy(() => import("../features/organization/OrganizationPage").then(({ OrganizationPage: Page }) => ({ default: Page })));
const SetupPage = lazy(() => import("../features/onboarding/SetupPage").then(({ SetupPage: Page }) => ({ default: Page })));
const RolesPage = lazy(() => import("../features/roles/RolesPage").then(({ RolesPage: Page }) => ({ default: Page })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then(({ SettingsPage: Page }) => ({ default: Page })));
const UsersPage = lazy(() => import("../features/users/UsersPage").then(({ UsersPage: Page }) => ({ default: Page })));
const ProductsPage = lazy(() => import("../features/products/ProductsPage").then(({ ProductsPage: Page }) => ({ default: Page })));
const ProductFormPage = lazy(() => import("../features/products/ProductFormPage").then(({ ProductFormPage: Page }) => ({ default: Page })));
const LabelsPage = lazy(() => import("../features/labels/LabelsPage").then(({ LabelsPage: Page }) => ({ default: Page })));
const PriceListsPage = lazy(() => import("../features/products/PriceListsPage").then(({ PriceListsPage: Page }) => ({ default: Page })));
const ImportPage = lazy(() => import("../features/products/ImportPage").then(({ ImportPage: Page }) => ({ default: Page })));
const CatalogueSetupPage = lazy(() => import("../features/products/CatalogueSetupPage").then(({ CatalogueSetupPage: Page }) => ({ default: Page })));
const StockPage = lazy(() => import("../features/stock/StockPage").then(({ StockPage: Page }) => ({ default: Page })));
const LedgerPage = lazy(() => import("../features/stock/LedgerPage").then(({ LedgerPage: Page }) => ({ default: Page })));
const AdjustmentsPage = lazy(() => import("../features/stock/AdjustmentsPage").then(({ AdjustmentsPage: Page }) => ({ default: Page })));
const NewAdjustmentPage = lazy(() => import("../features/stock/NewAdjustmentPage").then(({ NewAdjustmentPage: Page }) => ({ default: Page })));
const OpeningStockPage = lazy(() => import("../features/stock/OpeningStockPage").then(({ OpeningStockPage: Page }) => ({ default: Page })));
const CustomersPage = lazy(() => import("../features/customers/CustomersPage").then(({ CustomersPage: Page }) => ({ default: Page })));
const CustomerFormPage = lazy(() => import("../features/customers/CustomerFormPage").then(({ CustomerFormPage: Page }) => ({ default: Page })));
const CustomerLedgerPage = lazy(() => import("../features/customers/CustomerLedgerPage").then(({ CustomerLedgerPage: Page }) => ({ default: Page })));
const PurchaseOrdersPage = lazy(() => import("../features/purchasing/PurchaseOrdersPage").then(({ PurchaseOrdersPage: Page }) => ({ default: Page })));
const PurchaseOrderFormPage = lazy(() => import("../features/purchasing/PurchaseOrderFormPage").then(({ PurchaseOrderFormPage: Page }) => ({ default: Page })));
const PurchaseOrderPage = lazy(() => import("../features/purchasing/PurchaseOrderPage").then(({ PurchaseOrderPage: Page }) => ({ default: Page })));
const QuotationsPage = lazy(() => import("../features/quotations/QuotationsPage").then(({ QuotationsPage: Page }) => ({ default: Page })));
const QuotationFormPage = lazy(() => import("../features/quotations/QuotationFormPage").then(({ QuotationFormPage: Page }) => ({ default: Page })));
const QuotationPage = lazy(() => import("../features/quotations/QuotationPage").then(({ QuotationPage: Page }) => ({ default: Page })));
const SalesOrdersPage = lazy(() => import("../features/sales-orders/SalesOrdersPage").then(({ SalesOrdersPage: Page }) => ({ default: Page })));
const SalesOrderFormPage = lazy(() => import("../features/sales-orders/SalesOrderFormPage").then(({ SalesOrderFormPage: Page }) => ({ default: Page })));
const DeliveryChallansPage = lazy(() => import("../features/delivery/DeliveryChallansPage").then(({ DeliveryChallansPage: Page }) => ({ default: Page })));
const DeliveryChallanPage = lazy(() => import("../features/delivery/DeliveryChallanPage").then(({ DeliveryChallanPage: Page }) => ({ default: Page })));
const InvoicesPage = lazy(() => import("../features/invoices/InvoicesPage").then(({ InvoicesPage: Page }) => ({ default: Page })));
const InvoicePage = lazy(() => import("../features/invoices/InvoicePage").then(({ InvoicePage: Page }) => ({ default: Page })));
const PublicDocumentPage = lazy(() => import("../features/public/PublicDocumentPage").then(({ PublicDocumentPage: Page }) => ({ default: Page })));
const AccountsPage = lazy(() => import("../features/accounts/AccountsPage").then(({ AccountsPage: Page }) => ({ default: Page })));
const AccountPage = lazy(() => import("../features/accounts/AccountPage").then(({ AccountPage: Page }) => ({ default: Page })));
const ExpensesPage = lazy(() => import("../features/expenses/ExpensesPage").then(({ ExpensesPage: Page }) => ({ default: Page })));
const ExpenseFormPage = lazy(() => import("../features/expenses/ExpenseFormPage").then(({ ExpenseFormPage: Page }) => ({ default: Page })));
const ExpensePage = lazy(() => import("../features/expenses/ExpensePage").then(({ ExpensePage: Page }) => ({ default: Page })));
const ReportsPage = lazy(() => import("../features/reports/ReportsPage").then(({ ReportsPage: Page }) => ({ default: Page })));
const ReportPage = lazy(() => import("../features/reports/ReportPage").then(({ ReportPage: Page }) => ({ default: Page })));
const DashboardPanel = lazy(() => import("../features/dashboard/DashboardPanel").then(({ DashboardPanel: Panel }) => ({ default: Panel })));
const SalesOrderPage = lazy(() => import("../features/sales-orders/SalesOrderPage").then(({ SalesOrderPage: Page }) => ({ default: Page })));
const ReceiveGoodsPage = lazy(() => import("../features/purchasing/ReceiveGoodsPage").then(({ ReceiveGoodsPage: Page }) => ({ default: Page })));
const GoodsReceiptsPage = lazy(() => import("../features/purchasing/GoodsReceiptsPage").then(({ GoodsReceiptsPage: Page }) => ({ default: Page })));
const GoodsReceiptPage = lazy(() => import("../features/purchasing/GoodsReceiptPage").then(({ GoodsReceiptPage: Page }) => ({ default: Page })));
const PurchaseBillsPage = lazy(() => import("../features/purchasing/PurchaseBillsPage").then(({ PurchaseBillsPage: Page }) => ({ default: Page })));
const PurchaseBillFormPage = lazy(() => import("../features/purchasing/PurchaseBillFormPage").then(({ PurchaseBillFormPage: Page }) => ({ default: Page })));
const PurchaseBillPage = lazy(() => import("../features/purchasing/PurchaseBillPage").then(({ PurchaseBillPage: Page }) => ({ default: Page })));
const PurchaseReturnsPage = lazy(() => import("../features/purchasing/PurchaseReturnsPage").then(({ PurchaseReturnsPage: Page }) => ({ default: Page })));
const PurchaseReturnFormPage = lazy(() => import("../features/purchasing/PurchaseReturnFormPage").then(({ PurchaseReturnFormPage: Page }) => ({ default: Page })));
const PurchaseReturnPage = lazy(() => import("../features/purchasing/PurchaseReturnPage").then(({ PurchaseReturnPage: Page }) => ({ default: Page })));
const SupplierPaymentsPage = lazy(() => import("../features/suppliers/SupplierPaymentsPage").then(({ SupplierPaymentsPage: Page }) => ({ default: Page })));
const ReorderPage = lazy(() => import("../features/purchasing/ReorderPage").then(({ ReorderPage: Page }) => ({ default: Page })));
const SuppliersPage = lazy(() => import("../features/suppliers/SuppliersPage").then(({ SuppliersPage: Page }) => ({ default: Page })));
const SupplierFormPage = lazy(() => import("../features/suppliers/SupplierFormPage").then(({ SupplierFormPage: Page }) => ({ default: Page })));
const SupplierLedgerPage = lazy(() => import("../features/suppliers/SupplierLedgerPage").then(({ SupplierLedgerPage: Page }) => ({ default: Page })));
const SupplierAgeingPage = lazy(() => import("../features/suppliers/SupplierAgeingPage").then(({ SupplierAgeingPage: Page }) => ({ default: Page })));
const OpeningPayablesPage = lazy(() => import("../features/suppliers/OpeningPayablesPage").then(({ OpeningPayablesPage: Page }) => ({ default: Page })));
const ChequesPage = lazy(() => import("../features/customers/ChequesPage").then(({ ChequesPage: Page }) => ({ default: Page })));
const CustomerStatementPage = lazy(() => import("../features/customers/CustomerStatementPage").then(({ CustomerStatementPage: Page }) => ({ default: Page })));
const CustomerAgeingPage = lazy(() => import("../features/customers/CustomerAgeingPage").then(({ CustomerAgeingPage: Page }) => ({ default: Page })));
const OpeningBalancesPage = lazy(() => import("../features/customers/OpeningBalancesPage").then(({ OpeningBalancesPage: Page }) => ({ default: Page })));
const CustomerSetupPage = lazy(() => import("../features/customers/CustomerSetupPage").then(({ CustomerSetupPage: Page }) => ({ default: Page })));
const ReturnsPage = lazy(() => import("../features/returns/ReturnsPage").then(({ ReturnsPage: Page }) => ({ default: Page })));
const DailySalesPage = lazy(() => import("../features/reports/DailySalesPage").then(({ DailySalesPage: Page }) => ({ default: Page })));
const PosPage = lazy(() => import("../pos/PosPage").then(({ PosPage: Page }) => ({ default: Page })));
const ValuationPage = lazy(() => import("../features/stock/ValuationPage").then(({ ValuationPage: Page }) => ({ default: Page })));

type AppRoute = {
  path: string;
  label: string;
  permission?: string;
  element: ReactNode;
  /** False for pages reached from another page rather than the menu. */
  nav?: boolean;
};

const appRoutes: AppRoute[] = [
  { path: "/", label: "Overview", element: <Dashboard /> },
  { path: "/organization", label: "Business & organisation", permission: "business.view", element: <OrganizationPage /> },
  { path: "/products", label: "Products", permission: "catalog.view", element: <ProductsPage /> },
  { path: "/products/new", label: "New product", permission: "catalog.manage", element: <ProductFormPage />, nav: false },
  { path: "/products/labels", label: "Print labels", permission: "catalog.view", element: <LabelsPage />, nav: false },
  { path: "/products/import", label: "Import products", permission: "products.import", element: <ImportPage />, nav: false },
  { path: "/products/:id", label: "Edit product", permission: "catalog.manage", element: <ProductFormPage />, nav: false },
  { path: "/price-lists", label: "Price lists", permission: "catalog.view", element: <PriceListsPage /> },
  { path: "/catalogue", label: "Categories & tax", permission: "catalog.view", element: <CatalogueSetupPage /> },
  { path: "/stock", label: "Stock", permission: "inventory.view", element: <StockPage /> },
  { path: "/stock/ledger", label: "Stock movements", permission: "inventory.view", element: <LedgerPage />, nav: false },
  { path: "/stock/adjustments", label: "Stock adjustments", permission: "inventory.view", element: <AdjustmentsPage />, nav: false },
  { path: "/stock/adjustments/new", label: "New stock adjustment", permission: "inventory.adjust", element: <NewAdjustmentPage />, nav: false },
  { path: "/stock/opening", label: "Opening stock", permission: "inventory.opening_stock", element: <OpeningStockPage />, nav: false },
  { path: "/stock/valuation", label: "Stock valuation", permission: "products.cost.view", element: <ValuationPage />, nav: false },
  { path: "/customers", label: "Customers", permission: "customers.view", element: <CustomersPage /> },
  { path: "/customers/new", label: "New customer", permission: "customers.manage", element: <CustomerFormPage />, nav: false },
  { path: "/customers/setup", label: "Customer groups and areas", permission: "customers.view", element: <CustomerSetupPage />, nav: false },
  { path: "/customers/:id/ledger", label: "Customer khata", permission: "customers.ledger", element: <CustomerLedgerPage />, nav: false },
  { path: "/customers/:id/statement", label: "Customer statement", permission: "customers.ledger", element: <CustomerStatementPage />, nav: false },
  { path: "/suppliers", label: "Suppliers", permission: "suppliers.view", element: <SuppliersPage /> },
  { path: "/suppliers/new", label: "New supplier", permission: "suppliers.manage", element: <SupplierFormPage />, nav: false },
  { path: "/suppliers/opening-payables", label: "Opening payables", permission: "suppliers.manage", element: <OpeningPayablesPage />, nav: false },
  { path: "/suppliers/:id/ledger", label: "Supplier ledger", permission: "suppliers.ledger", element: <SupplierLedgerPage />, nav: false },
  { path: "/suppliers/:id", label: "Edit supplier", permission: "suppliers.manage", element: <SupplierFormPage />, nav: false },
  { path: "/quotations", label: "Quotations", permission: "quotations.view", element: <QuotationsPage /> },
  { path: "/quotations/new", label: "New quotation", permission: "quotations.manage", element: <QuotationFormPage />, nav: false },
  { path: "/quotations/:id/edit", label: "Change quotation", permission: "quotations.manage", element: <QuotationFormPage />, nav: false },
  { path: "/quotations/:id", label: "Quotation", permission: "quotations.view", element: <QuotationPage />, nav: false },
  { path: "/invoices", label: "Invoices", permission: "invoices.view", element: <InvoicesPage /> },
  { path: "/invoices/new", label: "New invoice", permission: "invoices.create", element: <SalesOrderFormPage mode="invoice" />, nav: false },
  { path: "/invoices/:id", label: "Invoice", permission: "invoices.view", element: <InvoicePage />, nav: false },
  { path: "/expenses", label: "Expenses", permission: "expenses.view", element: <ExpensesPage /> },
  { path: "/expenses/new", label: "Record an expense", permission: "expenses.create", element: <ExpenseFormPage />, nav: false },
  { path: "/expenses/:id", label: "Expense", permission: "expenses.view", element: <ExpensePage />, nav: false },
  { path: "/accounts", label: "Accounts", permission: "accounts.view", element: <AccountsPage /> },
  { path: "/accounts/:id", label: "Account", permission: "accounts.view", element: <AccountPage />, nav: false },
  { path: "/sales-orders", label: "Sales orders", permission: "sales_orders.view", element: <SalesOrdersPage /> },
  { path: "/sales-orders/new", label: "New sales order", permission: "sales_orders.manage", element: <SalesOrderFormPage />, nav: false },
  { path: "/sales-orders/:id", label: "Sales order", permission: "sales_orders.view", element: <SalesOrderPage />, nav: false },
  { path: "/delivery-challans", label: "Delivery challans", permission: "delivery.view", element: <DeliveryChallansPage /> },
  { path: "/delivery-challans/:id", label: "Delivery challan", permission: "delivery.view", element: <DeliveryChallanPage />, nav: false },
  { path: "/purchase-orders", label: "Purchase orders", permission: "purchasing.view", element: <PurchaseOrdersPage /> },
  { path: "/purchase-orders/new", label: "New purchase order", permission: "purchasing.order", element: <PurchaseOrderFormPage />, nav: false },
  { path: "/purchase-orders/:id/edit", label: "Change purchase order", permission: "purchasing.order", element: <PurchaseOrderFormPage />, nav: false },
  { path: "/purchase-orders/:id", label: "Purchase order", permission: "purchasing.view", element: <PurchaseOrderPage />, nav: false },
  { path: "/goods-receipts", label: "Goods receipts", permission: "purchasing.view", element: <GoodsReceiptsPage /> },
  { path: "/goods-receipts/new", label: "Receive goods", permission: "purchasing.receive", element: <ReceiveGoodsPage />, nav: false },
  { path: "/goods-receipts/:id", label: "Goods receipt", permission: "purchasing.view", element: <GoodsReceiptPage />, nav: false },
  { path: "/purchase-bills", label: "Supplier bills", permission: "purchasing.bill", element: <PurchaseBillsPage /> },
  { path: "/purchase-bills/new", label: "Enter a supplier bill", permission: "purchasing.bill", element: <PurchaseBillFormPage />, nav: false },
  { path: "/purchase-bills/:id", label: "Supplier bill", permission: "purchasing.bill", element: <PurchaseBillPage />, nav: false },
  { path: "/purchase-returns", label: "Purchase returns", permission: "purchasing.view", element: <PurchaseReturnsPage /> },
  { path: "/purchase-returns/new", label: "Return goods to a supplier", permission: "purchasing.return", element: <PurchaseReturnFormPage />, nav: false },
  { path: "/purchase-returns/:id", label: "Purchase return", permission: "purchasing.view", element: <PurchaseReturnPage />, nav: false },
  { path: "/supplier-payments", label: "Payments made", permission: "suppliers.ledger", element: <SupplierPaymentsPage /> },
  { path: "/reorder", label: "Reorder list", permission: "purchasing.view", element: <ReorderPage /> },
  { path: "/supplier-ageing", label: "Payables ageing", permission: "suppliers.ledger", element: <SupplierAgeingPage /> },
  { path: "/cheques", label: "Cheques", permission: "customers.ledger", element: <ChequesPage /> },
  { path: "/customer-ageing", label: "Customer ageing", permission: "customers.ledger", element: <CustomerAgeingPage /> },
  { path: "/customers/opening-balances", label: "Customer opening balances", permission: "customers.manage", element: <OpeningBalancesPage />, nav: false },
  { path: "/customers/:id", label: "Edit customer", permission: "customers.manage", element: <CustomerFormPage />, nav: false },
  { path: "/returns", label: "Returns", permission: "sales.return", element: <ReturnsPage /> },
  { path: "/reports", label: "Reports", element: <ReportsPage /> },
  { path: "/reports/daily-sales", label: "Daily sales", permission: "reports.sales.view", element: <DailySalesPage />, nav: false },
  { path: "/reports/:key", label: "Report", element: <ReportPage />, nav: false },
  { path: "/users", label: "Users", permission: "users.view", element: <UsersPage /> },
  { path: "/roles", label: "Roles & permissions", permission: "roles.view", element: <RolesPage /> },
  { path: "/settings", label: "Settings", permission: "settings.view", element: <SettingsPage /> },
  { path: "/audit", label: "Audit history", permission: "audit.view", element: <AuditPage /> },
];

export function App() {
  return <BrowserRouter><Suspense fallback={<div className="full-message">Loading page…</div>}><AppRoutes /></Suspense></BrowserRouter>;
}

function AppRoutes() {
  const { session, currentUser, loading, authError, refreshCurrentUser, signOut } = useAuth();
  const location = useLocation();

  // A shared link opens for anyone, signed in or not, and shows nothing but the document.
  if (location.pathname.startsWith("/d/")) return <PublicDocumentPage />;
  if (loading) return <div className="full-message">Loading your secure session…</div>;
  if (!session) {
    return <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>;
  }
  if (!currentUser) {
    return <main className="auth-page"><section className="auth-card">
      <h1>Unable to load your profile</h1>
      <ErrorMessage>{authError || "Your profile could not be loaded."}</ErrorMessage>
      <div className="button-row">
        <button className="button primary" onClick={() => void refreshCurrentUser()}>Try again</button>
        <button className="button secondary" onClick={() => void signOut()}>Sign out</button>
      </div>
    </section></main>;
  }
  if (!currentUser.businessId && location.pathname !== "/setup") return <Navigate to="/setup" replace />;
  if (currentUser.businessId && location.pathname === "/setup") return <Navigate to="/" replace />;
  if (!currentUser.businessId) return <Routes><Route path="/setup" element={<SetupPage />} /><Route path="*" element={<Navigate to="/setup" replace />} /></Routes>;

  // The till is a full screen of its own, without the back-office menu.
  if (location.pathname === "/pos") return <ErrorBoundary><PosPage /></ErrorBoundary>;

  return <Shell>
    <ErrorBoundary key={location.pathname}>
    <Routes>
      {appRoutes.map((route) => <Route key={route.path} path={route.path} element={
        route.permission && !hasPermission(currentUser.permissions, route.permission)
          ? <AccessDenied />
          : route.element
      } />)}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ErrorBoundary>
  </Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const { currentUser, signOut } = useAuth();
  const terminalId = useTerminalStore((state) => state.terminalId);
  const setTerminalId = useTerminalStore((state) => state.setTerminalId);
  const terminalQuery = useQuery({
    queryKey: ["terminals", currentUser?.businessId],
    queryFn: getAllTerminals,
    enabled: hasPermission(currentUser?.permissions ?? [], "terminals.view"),
  });
  const terminals = (terminalQuery.data ?? []).filter((terminal) => terminal.active);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [switchBusy, setSwitchBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Wait for the list: while it loads (or after a cache clear) it is empty, and the saved terminal would be wiped.
    if (!terminalQuery.isSuccess) return;
    if (terminalId && !terminals.some((terminal) => terminal.id === terminalId)) {
      setTerminalId(terminals[0]?.id ?? "");
    } else if (!terminalId && terminals[0]) {
      setTerminalId(terminals[0].id);
    }
  }, [terminalQuery.isSuccess, terminalId, terminals, setTerminalId]);

  const visibleRoutes = appRoutes.filter((route) => route.nav !== false && (!route.permission || hasPermission(currentUser?.permissions ?? [], route.permission)));

  async function submitPinSwitch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSwitchError("");
    setSwitchBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      if (!terminalId) throw new Error("Choose a terminal before switching users");
      await switchTerminalUser({
        targetEmail: String(data.get("email")),
        pin: String(data.get("pin")),
        terminalId,
      });
      window.location.reload();
    } catch (caught) {
      setSwitchError(caught instanceof Error ? caught.message : "Could not switch terminal user");
    } finally {
      setSwitchBusy(false);
    }
  }

  function changeTerminal(value: string) {
    sessionStorage.removeItem("pos.pinSession");
    setTerminalId(value);
    window.location.reload();
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <Link to="/" className="brand"><span className="brand-mark">P</span><span>POS System<small>Foundation</small></span></Link>
      <nav aria-label="Main navigation">
        {hasPermission(currentUser?.permissions ?? [], "sales.create") && <NavLink to="/pos" className="nav-link">Point of sale</NavLink>}
        {visibleRoutes.map((route) => <NavLink key={route.path} to={route.path} className={({ isActive }) => isActive ? "nav-link selected" : "nav-link"}>{route.label}</NavLink>)}
      </nav>
      <nav className="planned-nav" aria-label="Coming soon">
        <p className="eyebrow">Coming soon</p>
        {plannedModules.map((module) => <span key={module.label} className="nav-link disabled" aria-disabled="true" title={`Planned for ${module.version}`}>
          {module.label}<small className="badge">Under development</small>
        </span>)}
      </nav>
      <div className="sidebar-bottom">
        <span className="user-initial">{(currentUser?.activeUserName ?? currentUser?.email ?? "U").slice(0, 1).toUpperCase()}</span>
        <div className="user-summary"><strong>{currentUser?.activeUserName ?? currentUser?.activeUserEmail ?? "Signed in"}</strong><small>{currentUser?.activeUserEmail}</small></div>
        <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void signOut().then(() => navigate("/login"))}>↪</button>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div><p className="eyebrow">Business workspace</p><p className="topbar-user">{currentUser?.activeUserName ?? currentUser?.activeUserEmail}</p></div>
        <div className="topbar-actions">
          {terminals.length > 0 && <label className="terminal-choice"><span>Terminal</span><SelectInput aria-label="Terminal" value={terminalId} onChange={(event) => changeTerminal(event.target.value)}>{terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.name}</option>)}</SelectInput></label>}
          {terminalQuery.isError && <span className="muted" role="status">Terminal list unavailable</span>}
          {hasPermission(currentUser?.permissions ?? [], "auth.pin_switch") && <button className="button secondary" onClick={() => setSwitchOpen((open) => !open)}>Switch user</button>}
        </div>
      </header>
      {switchOpen && <form className="switch-panel" onSubmit={submitPinSwitch}>
        <Field label="Staff email"><TextInput name="email" type="email" required autoComplete="username" /></Field>
        <Field label="PIN"><TextInput name="pin" inputMode="numeric" pattern="[0-9]{4,6}" minLength={4} maxLength={6} required autoComplete="one-time-code" /></Field>
        {switchError && <ErrorMessage>{switchError}</ErrorMessage>}
        <button className="button primary" disabled={switchBusy}>{switchBusy ? "Switching…" : "Switch terminal user"}</button>
      </form>}
      {children}
    </main>
  </div>;
}

function Dashboard() {
  const { currentUser } = useAuth();
  const cards = appRoutes.filter((route) => route.path !== "/" && route.nav !== false && (!route.permission || hasPermission(currentUser?.permissions ?? [], route.permission)));
  return <div className="content">
    <div className="welcome-panel">
      <p className="eyebrow">Release v0.7 · Reports, accounts and expenses</p>
      <h1>Welcome{currentUser?.activeUserName ? `, ${currentUser.activeUserName}` : ""}</h1>
      <p>Selling, stock, customers, suppliers, quotations, orders, reports and expenses are ready. Modules marked “Under development” in the menu arrive in later releases.</p>
    </div>
    <DashboardPanel />
    <div className="dashboard-grid">{cards.map((route) => <Link className="dashboard-card" key={route.path} to={route.path}>
      <span className="card-arrow">↗</span><strong>{route.label}</strong><small>Open workspace</small>
    </Link>)}</div>
    <section className="foundation-note"><strong>v0.7 Reports, dashboard and expenses</strong><span>Next: FBR integration · v0.8</span></section>
  </div>;
}

function AccessDenied() {
  return <div className="content narrow"><section className="panel"><h1>Access denied</h1><p className="muted">Your role does not allow access to this page. Contact the business owner if you need access.</p></section></div>;
}
