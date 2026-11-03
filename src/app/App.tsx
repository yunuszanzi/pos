import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getAllTerminals } from "../api/orgApi";
import { switchTerminalUser } from "../api/authApi";
import { useAuth } from "./useAuth";
import { useTerminalStore } from "./terminalStore";
import { ErrorMessage, Field, SelectInput, TextInput } from "./FormElements";

const AuditPage = lazy(() => import("../features/audit/AuditPage").then(({ AuditPage: Page }) => ({ default: Page })));
const LoginPage = lazy(() => import("../features/auth/LoginPage").then(({ LoginPage: Page }) => ({ default: Page })));
const OrganizationPage = lazy(() => import("../features/organization/OrganizationPage").then(({ OrganizationPage: Page }) => ({ default: Page })));
const SetupPage = lazy(() => import("../features/onboarding/SetupPage").then(({ SetupPage: Page }) => ({ default: Page })));
const RolesPage = lazy(() => import("../features/roles/RolesPage").then(({ RolesPage: Page }) => ({ default: Page })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then(({ SettingsPage: Page }) => ({ default: Page })));
const UsersPage = lazy(() => import("../features/users/UsersPage").then(({ UsersPage: Page }) => ({ default: Page })));

type AppRoute = {
  path: string;
  label: string;
  permission?: string;
  element: ReactNode;
};

const appRoutes: AppRoute[] = [
  { path: "/", label: "Overview", element: <Dashboard /> },
  { path: "/organization", label: "Business & organisation", permission: "business.view", element: <OrganizationPage /> },
  { path: "/users", label: "Users", permission: "users.view", element: <UsersPage /> },
  { path: "/roles", label: "Roles & permissions", permission: "roles.view", element: <RolesPage /> },
  { path: "/settings", label: "Settings", permission: "settings.view", element: <SettingsPage /> },
  { path: "/audit", label: "Audit history", permission: "audit.view", element: <AuditPage /> },
];

export function App() {
  return <BrowserRouter><Suspense fallback={<div className="full-message">Loading page…</div>}><AppRoutes /></Suspense></BrowserRouter>;
}

function AppRoutes() {
  const { session, currentUser, loading, authError, refreshCurrentUser } = useAuth();
  const location = useLocation();

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
      <button className="button primary" onClick={() => void refreshCurrentUser()}>Try again</button>
    </section></main>;
  }
  if (!currentUser.businessId && location.pathname !== "/setup") return <Navigate to="/setup" replace />;
  if (currentUser.businessId && location.pathname === "/setup") return <Navigate to="/" replace />;
  if (!currentUser.businessId) return <Routes><Route path="/setup" element={<SetupPage />} /><Route path="*" element={<Navigate to="/setup" replace />} /></Routes>;

  return <Shell>
    <Routes>
      {appRoutes.map((route) => <Route key={route.path} path={route.path} element={
        route.permission && !hasPermission(currentUser.permissions, route.permission)
          ? <AccessDenied />
          : route.element
      } />)}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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

  const visibleRoutes = appRoutes.filter((route) => !route.permission || hasPermission(currentUser?.permissions ?? [], route.permission));

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
        {visibleRoutes.map((route) => <NavLink key={route.path} to={route.path} className={({ isActive }) => isActive ? "nav-link selected" : "nav-link"}>{route.label}</NavLink>)}
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
  const cards = appRoutes.filter((route) => route.path !== "/" && (!route.permission || hasPermission(currentUser?.permissions ?? [], route.permission)));
  return <div className="content">
    <div className="welcome-panel">
      <p className="eyebrow">Foundation release · v0.1</p>
      <h1>Welcome{currentUser?.activeUserName ? `, ${currentUser.activeUserName}` : ""}</h1>
      <p>Business access, staff, roles and organisation setup are ready. Catalogue and sales features arrive in later releases.</p>
    </div>
    <div className="dashboard-grid">{cards.map((route) => <Link className="dashboard-card" key={route.path} to={route.path}>
      <span className="card-arrow">↗</span><strong>{route.label}</strong><small>Open workspace</small>
    </Link>)}</div>
    <section className="foundation-note"><strong>v0.1 Foundation</strong><span>Next: catalogue and stock management · v0.2</span></section>
  </div>;
}

function AccessDenied() {
  return <div className="content narrow"><section className="panel"><h1>Access denied</h1><p className="muted">Your role does not allow access to this page. Contact the business owner if you need access.</p></section></div>;
}

function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes("*") || permissions.includes(permission);
}
