import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

export const hasLocalStack = Boolean(
  process.env.DATABASE_URL && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

export const testPassword = "correct-horse-battery";

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };

function supabaseAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, clientOptions);
}

export function supabaseAnon() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, clientOptions);
}

export function sql() {
  return postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
}

export function uniqueEmail(label: string): string {
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}@example.test`;
}

export async function createConfirmedAuthUser(email: string): Promise<string> {
  const { data, error } = await supabaseAdmin().auth.admin.createUser({ email, password: testPassword, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Auth user was not created");
  return data.user.id;
}

export async function setAuthPassword(userId: string): Promise<void> {
  const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, { password: testPassword, email_confirm: true });
  if (error) throw error;
}

export async function signIn(email: string): Promise<string> {
  const { data, error } = await supabaseAnon().auth.signInWithPassword({ email, password: testPassword });
  if (error || !data.session) throw error ?? new Error("Sign-in returned no session");
  return data.session.access_token;
}

type ApiResponse<T> = { status: number; body: T; headers: Headers };
type CallOptions = { body?: unknown; terminalId?: string; pinSession?: string; idempotencyKey?: string };

// Response shapes vary per route; tests assert on them directly instead of typing each one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callApi<T = any>(token: string, method: string, path: string, options: CallOptions = {}): Promise<ApiResponse<T>> {
  const headers = new Headers({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  if (options.terminalId) headers.set("X-Terminal-Id", options.terminalId);
  if (options.pinSession) headers.set("X-PIN-Session", options.pinSession);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  // Integration tests call the Hono app in-process; e2e tests set TEST_API_URL to use the running server.
  const baseUrl = process.env.TEST_API_URL ?? "http://localhost";
  const request = new Request(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const response = process.env.TEST_API_URL
    ? await fetch(request)
    : await (await import("../../server/app")).app.fetch(request);
  return { status: response.status, body: await response.json() as T, headers: response.headers };
}

export type TestBusiness = {
  ownerEmail: string;
  ownerId: string;
  ownerToken: string;
  ownerPin: string;
  businessId: string;
  branchId: string;
  terminalId: string;
  roleIds: Record<string, string>;
};

export async function createTestBusiness(): Promise<TestBusiness> {
  const ownerEmail = uniqueEmail("owner");
  const ownerId = await createConfirmedAuthUser(ownerEmail);
  const ownerToken = await signIn(ownerEmail);
  const ownerPin = "2468";
  const setup = await callApi(ownerToken, "POST", "/org/setup", {
    body: {
      legalName: "Example Traders (Pvt) Ltd",
      tradeName: "Example Traders",
      branchName: "Main Branch",
      branchCode: "KHI",
      locationName: "Main Store",
      terminalName: "Register 1",
      documentPrefix: "INV-KHI",
      ownerPin,
    },
  });
  if (setup.status !== 201) throw new Error(`Business setup failed: ${JSON.stringify(setup.body)}`);
  const roles = await callApi<Array<{ id: string; name: string }>>(ownerToken, "GET", "/roles");
  return {
    ownerEmail,
    ownerId,
    ownerToken,
    ownerPin,
    businessId: setup.body.business.id,
    branchId: setup.body.branch.id,
    terminalId: setup.body.terminal.id,
    roleIds: Object.fromEntries(roles.body.map((role) => [role.name, role.id])),
  };
}

export type TestStaff = { id: string; email: string; token: string; pin: string };

export async function inviteTestStaff(business: TestBusiness, roleName: string, inviterToken = business.ownerToken): Promise<TestStaff> {
  const email = uniqueEmail(roleName.toLowerCase());
  const pin = "1357";
  const created = await callApi(inviterToken, "POST", "/users", {
    body: { email, displayName: roleName, roleId: business.roleIds[roleName], branchIds: [business.branchId], pin },
  });
  if (created.status !== 201) throw new Error(`Inviting ${roleName} failed: ${JSON.stringify(created.body)}`);
  await setAuthPassword(created.body.id);
  return { id: created.body.id, email, token: await signIn(email), pin };
}
