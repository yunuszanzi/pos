// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, inviteTestStaff, sql } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

integration("API conventions and tenant isolation", { timeout: 60_000 }, () => {
  it("rejects requests without a valid Supabase token", async () => {
    const response = await callApi("not-a-real-token", "GET", "/me");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns validation failures in the standard error shape", async () => {
    const business = await createTestBusiness();
    const response = await callApi(business.ownerToken, "POST", "/branches", { body: { name: "", code: "has spaces" } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
    expect(response.body.error.message).toMatch(/^name: /);
    expect(response.body.error.details.map((issue: { path: string }) => issue.path)).toEqual(["name", "code"]);
  });

  it("never lets one business read or change another business's records", async () => {
    const shopA = await createTestBusiness();
    const shopB = await createTestBusiness();
    const cashierA = await inviteTestStaff(shopA, "Cashier");

    const branches = await callApi(shopB.ownerToken, "GET", "/branches");
    expect(branches.body.map((branch: { id: string }) => branch.id)).not.toContain(shopA.branchId);
    expect((await callApi(shopB.ownerToken, "PUT", `/branches/${shopA.branchId}`, { body: { name: "Taken" } })).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "PUT", `/users/${cashierA.id}`, { body: { active: false } })).status).toBe(404);
    expect((await callApi(shopB.ownerToken, "POST", `/users/${cashierA.id}/password-reset`)).status).toBe(404);
    const location = await callApi(shopB.ownerToken, "POST", "/locations", { body: { branchId: shopA.branchId, name: "Sneaky" } });
    expect(location.body.error.code).toBe("INVALID_BRANCH");
    const foreignTerminal = await callApi(shopB.ownerToken, "GET", "/me", { terminalId: shopA.terminalId });
    expect(foreignTerminal.body.error.code).toBe("TERMINAL_NOT_FOUND");
    const audit = await callApi(shopB.ownerToken, "GET", "/audit-log?pageSize=100");
    expect(audit.body.data.every((entry: { businessId: string }) => entry.businessId === shopB.businessId)).toBe(true);
  });

  it("answers 404, not a server error, for a malformed id in any path", async () => {
    const business = await createTestBusiness();
    for (const [method, path] of [
      ["PUT", "/branches/abc"], ["PUT", "/locations/abc"], ["PUT", "/terminals/abc"], ["PUT", "/document-series/abc"],
      ["PUT", "/users/abc"], ["POST", "/users/abc/password-reset"], ["PUT", "/roles/abc"],
    ] as const) {
      const response = await callApi(business.ownerToken, method, path, { body: { name: "x", code: "x", permissionKeys: [], active: true } });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("expires a back-office session after the inactivity timeout (FR-USR-01)", async () => {
    const business = await createTestBusiness();
    expect((await callApi(business.ownerToken, "GET", "/me")).status).toBe(200);
    const client = sql();
    try {
      await client`UPDATE auth_sessions SET last_activity_at = now() - interval '31 minutes' WHERE user_id = ${business.ownerId}`;
    } finally {
      await client.end();
    }
    const expired = await callApi(business.ownerToken, "GET", "/me");
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("SESSION_INACTIVE");
  });
});
