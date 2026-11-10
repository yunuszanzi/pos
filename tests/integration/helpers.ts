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
type CallOptions = { body?: unknown; terminalId?: string; pinSession?: string; idempotencyKey?: string; headers?: Record<string, string> };

// Response shapes vary per route; tests assert on them directly instead of typing each one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callApi<T = any>(token: string, method: string, path: string, options: CallOptions = {}): Promise<ApiResponse<T>> {
  const headers = new Headers({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  if (options.terminalId) headers.set("X-Terminal-Id", options.terminalId);
  if (options.pinSession) headers.set("X-PIN-Session", options.pinSession);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
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

/** A custom role holding exactly the given permission keys, and a staff member in it. */
export async function inviteStaffWithPermissions(business: TestBusiness, roleName: string, permissionKeys: string[]): Promise<TestStaff> {
  const role = await callApi(business.ownerToken, "POST", "/roles", { body: { name: roleName, permissionKeys } });
  if (role.status !== 201) throw new Error(`Creating role ${roleName} failed: ${JSON.stringify(role.body)}`);
  business.roleIds[roleName] = role.body.id;
  return inviteTestStaff(business, roleName);
}

export type SimpleProduct = { productId: string; variantId: string; pieceId: string; cartonId: string; packId: string };

/** A product sold in pieces (base), packs of 10 and cartons of 200, with barcodes `${sku}-PC`, `-PK` and `-CTN`. */
export async function createSimpleProduct(business: TestBusiness, sku: string, costPaisa = 100, extra: Record<string, unknown> = {}): Promise<SimpleProduct> {
  const units = await callApi<Array<{ id: string; name: string }>>(business.ownerToken, "GET", "/units");
  const unit = (name: string) => units.body.find((row) => row.name === name)!.id;
  const [pieceId, packId, cartonId] = [unit("Piece"), unit("Pack"), unit("Carton")];
  const created = await callApi(business.ownerToken, "POST", "/products", {
    body: {
      name: `Product ${sku}`,
      baseUnitId: pieceId,
      ...extra,
      variants: [{
        sku, costPaisa, reorderLevel: "0",
        units: [
          { unitId: pieceId, factorToBase: "1", barcode: `${sku}-PC`, salePricePaisa: 500 },
          { unitId: packId, factorToBase: "10", barcode: `${sku}-PK`, salePricePaisa: 4800 },
          { unitId: cartonId, factorToBase: "200", barcode: `${sku}-CTN`, salePricePaisa: 90000 },
        ],
      }],
    },
  });
  if (created.status !== 201) throw new Error(`Creating product ${sku} failed: ${JSON.stringify(created.body)}`);
  return { productId: created.body.id, variantId: created.body.variants[0].id, pieceId, cartonId, packId };
}

export async function firstLocationId(business: TestBusiness): Promise<string> {
  const locations = await callApi<Array<{ id: string }>>(business.ownerToken, "GET", "/locations");
  return locations.body[0].id;
}

export async function setAdjustmentThreshold(business: TestBusiness, paisa: number): Promise<void> {
  const settings = await callApi(business.ownerToken, "GET", "/settings");
  const updated = await callApi(business.ownerToken, "PUT", "/settings", { body: { ...settings.body, adjustmentApprovalThresholdPaisa: paisa } });
  if (updated.status !== 200) throw new Error(`Setting the threshold failed: ${JSON.stringify(updated.body)}`);
}
