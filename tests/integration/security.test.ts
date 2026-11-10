// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { app } from "../../server/app";
import { callApi, createTestBusiness, hasLocalStack, inviteStaffWithPermissions, sql, supabaseAnon, testPassword } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

// v1.0 security review (NFR-SEC-01..03), as tests that keep running: every API route needs a signed-in person and a permission,
// and the database refuses direct access to other businesses' data even to someone holding a valid sign-in.

const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const someId = "11111111-1111-4111-8111-111111111111";
const routes = () => [...new Map(app.routes.filter((route) => route.path.startsWith("/api/v1/") && methods.includes(route.method)).map((route) => [`${route.method} ${route.path}`, route])).values()];
const concretePath = (path: string) => path.replace("/api/v1", "").replace(/:[A-Za-z]+(\{[^}]*\})?\??/g, someId).replace(/\*/g, "x");

/**
 * Routes a signed-in person with no permissions at all may reach, and why. A route not on this list must answer 403 to them.
 * Anything added here needs a reason; a new route that is not on the list and does not check permissions fails the test below.
 */
const openToAnySignedInPerson: Record<string, string> = {
  "GET /api/v1/me": "your own profile and permissions",
  "POST /api/v1/auth/login-event": "records your own sign-in",
  "POST /api/v1/auth/manager-override": "checks a manager's own email and PIN; the manager's permission is what is tested, and it is rate-limited",
  "POST /api/v1/org/setup": "first-time setup for someone with no business yet; refused once one exists",
  "GET /api/v1/report-catalogue": "lists only the reports you may run (none)",
  "GET /api/v1/report-data/:key": "checks the report's own permission inside (tested below for every report)",
  "POST /api/v1/document-shares": "checks the permission for the kind of document inside (tested below)",
  "POST /api/v1/document-shares/revoke": "checks the permission for the kind of document inside (tested below)",
  "GET /api/v1/dashboard": "sends each section only to someone allowed it (tested below)",
};

integration("every API route needs a sign-in and a permission", { timeout: 600_000 }, () => {
  it("answers 401 to every route without a sign-in", async () => {
    const failures: string[] = [];
    for (const route of routes()) {
      const response = await app.fetch(new Request(`http://localhost/api/v1${concretePath(route.path)}`, {
        method: route.method, headers: { "Content-Type": "application/json" }, body: route.method === "GET" ? undefined : "{}",
      }));
      if (response.status !== 401) failures.push(`${route.method} ${route.path} -> ${response.status}`);
    }
    expect(failures).toEqual([]);
    expect(routes().length).toBeGreaterThan(200);
  });

  it("answers 403 to a signed-in person with no permissions on every route, except those listed with a reason", async () => {
    const business = await createTestBusiness();
    const nobody = await inviteStaffWithPermissions(business, "Nobody", []);
    const reachable: string[] = [];
    for (const route of routes()) {
      const response = await callApi(nobody.token, route.method, concretePath(route.path), {
        body: route.method === "GET" ? undefined : {}, idempotencyKey: `audit-${crypto.randomUUID()}`,
      });
      if (response.status !== 403) reachable.push(`${route.method} ${route.path}`);
    }
    expect(reachable.sort()).toEqual(Object.keys(openToAnySignedInPerson).sort());
  });

  it("holds back what the listed routes check inside: reports, shares and the dashboard", async () => {
    const business = await createTestBusiness();
    const nobody = await inviteStaffWithPermissions(business, "Nobody", []);
    const catalogue = await callApi(business.ownerToken, "GET", "/report-catalogue");
    const keys: string[] = catalogue.body.data.map((report: { key: string }) => report.key);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      const denied = await callApi(nobody.token, "GET", `/report-data/${key}`);
      expect(denied.status, key).toBe(403);
    }
    expect(JSON.stringify((await callApi(nobody.token, "GET", "/report-catalogue")).body)).not.toContain(keys[0]);

    for (const type of ["quotation", "sales_order", "invoice", "delivery_challan"]) {
      const denied = await callApi(nobody.token, "POST", "/document-shares", { body: { type, id: someId } });
      expect(denied.status, type).toBe(403);
    }
    const board = await callApi(nobody.token, "GET", "/dashboard");
    expect(Object.keys(board.body)).toEqual(["date"]);
  });
});

integration("the database refuses direct access to other businesses' data", { timeout: 300_000 }, () => {
  async function signedIn(email: string) {
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email, password: testPassword });
    expect(error).toBeNull();
    return client;
  }

  it("has row-level security on every table", async () => {
    const database = sql();
    try {
      const rows = await database<{ relname: string }[]>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by c.relname`;
      expect(rows.map((row) => row.relname)).toEqual(["app_schema_migrations"]);
    } finally {
      await database.end();
    }
  });

  it("shows a signed-in person nothing of another business, and nothing at all in tables meant for the server alone", async () => {
    const mine = await createTestBusiness();
    const theirs = await createTestBusiness();
    // Give both businesses secrets and documents the server would hold.
    await callApi(theirs.ownerToken, "PUT", "/fbr/token", { body: { token: "mock-ok-token-theirs" } });
    await callApi(mine.ownerToken, "PUT", "/fbr/token", { body: { token: "mock-ok-token-mine" } });
    const client = await signedIn(mine.ownerEmail);
    const database = sql();
    try {
      const tables = await database<{ relname: string }[]>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'app_schema_migrations' order by c.relname`;
      const withPolicy = new Set((await database<{ tablename: string }[]>`select distinct tablename from pg_policies where schemaname = 'public'`).map((row) => row.tablename));
      for (const { relname } of tables) {
        const { data, error } = await client.from(relname).select("*").limit(1000);
        if (error) continue; // refused outright: nothing leaks
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        if (!withPolicy.has(relname)) {
          expect(rows, `${relname} has no policy, so a signed-in person must see no rows`).toEqual([]);
          continue;
        }
        // Where a table carries a business, every row seen is mine.
        for (const row of rows) {
          if ("business_id" in row) expect(row.business_id, relname).toBe(mine.businessId);
          if (relname === "businesses") expect(row.id).toBe(mine.businessId);
          if (relname === "users") expect(row.id).toBe(mine.ownerId);
        }
      }
      // Specifically: the encrypted FBR token is in a table no one signed in can read.
      const token = await client.from("fbr_config").select("*");
      expect(token.data ?? []).toEqual([]);
      // Whatever a table lets me read, it is only my own business (the access grants are withheld altogether, so today that is nothing).
      expect(((await client.from("businesses").select("id")).data ?? []).every((row) => row.id === mine.businessId)).toBe(true);
    } finally {
      await database.end();
    }
  });

  it("lets no one write through the public interface, even to their own rows", async () => {
    const mine = await createTestBusiness();
    const client = await signedIn(mine.ownerEmail);
    const attempts = [
      await client.from("businesses").update({ trade_name: "Hijacked" }).eq("id", mine.businessId).select(),
      await client.from("users").update({ role_id: mine.roleIds.Owner }).eq("id", mine.ownerId).select(),
      await client.from("roles").delete().eq("business_id", mine.businessId).select(),
      await client.from("business_settings").update({ allow_negative_stock: true }).eq("business_id", mine.businessId).select(),
      await client.from("audit_log").delete().eq("business_id", mine.businessId).select(),
    ];
    for (const attempt of attempts) expect(attempt.data ?? []).toEqual([]);
    const database = sql();
    try {
      const [row] = await database<{ trade_name: string }[]>`select trade_name from businesses where id = ${mine.businessId}`;
      expect(row.trade_name).toBe("Example Traders");
      const [{ roles }] = await database<{ roles: string }[]>`select count(*)::text as roles from roles where business_id = ${mine.businessId}`;
      expect(Number(roles)).toBeGreaterThanOrEqual(3);
    } finally {
      await database.end();
    }
  });

  it("shows someone who is not signed in nothing", async () => {
    const anonymous = supabaseAnon();
    const database = sql();
    try {
      const tables = await database<{ relname: string }[]>`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'app_schema_migrations'`;
      for (const { relname } of tables) {
        const { data } = await anonymous.from(relname).select("*").limit(5);
        expect(data ?? [], relname).toEqual([]);
      }
    } finally {
      await database.end();
    }
  });
});

integration("what is public stays small", { timeout: 120_000 }, () => {
  it("serves only the health check and share links without a sign-in, and keeps the scheduled jobs behind their secret", async () => {
    const open = app.routes.filter((route) => !route.path.startsWith("/api/v1") && route.path.startsWith("/api/") && methods.includes(route.method)).map((route) => `${route.method} ${route.path}`).sort();
    expect(open).toEqual([
      "GET /api/health",
      "GET /api/jobs/fbr-retry", "GET /api/jobs/fbr-sync", "POST /api/jobs/fbr-retry", "POST /api/jobs/fbr-sync",
      "GET /api/public/documents/:token",
    ].sort());
    for (const path of ["/api/jobs/fbr-retry", "/api/jobs/fbr-sync"]) {
      expect((await app.fetch(new Request(`http://localhost${path}`))).status).toBe(401);
      expect((await app.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer wrong-secret-wrong-secret" } }))).status).toBe(401);
    }
    expect((await app.fetch(new Request("http://localhost/api/public/documents/not-a-real-token"))).status).toBe(404);
  });

  it("sends the headers that stop a browser guessing, framing or caching an answer", async () => {
    const health = await app.fetch(new Request("http://localhost/api/health"));
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    const secured = await app.fetch(new Request("http://localhost/api/v1/me", { headers: { Authorization: "Bearer nope" } }));
    expect(secured.headers.get("cache-control")).toBe("no-store");
  });
});
