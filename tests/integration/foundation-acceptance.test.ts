// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, inviteTestStaff } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

integration("v0.1 acceptance against the real API", { timeout: 60_000 }, () => {
  it("1. owner creates the business, a branch, a terminal and a cashier", async () => {
    const business = await createTestBusiness();
    const branch = await callApi(business.ownerToken, "POST", "/branches", { body: { name: "Hyderabad", code: "HYD" } });
    expect(branch.status).toBe(201);
    const terminal = await callApi(business.ownerToken, "POST", "/terminals", { body: { branchId: branch.body.id, name: "HYD Counter" } });
    expect(terminal.status).toBe(201);
    expect(terminal.body.defaultPrintFormat).toBe("pos80");
    const cashier = await inviteTestStaff(business, "Cashier");
    const users = await callApi(business.ownerToken, "GET", "/users");
    expect(users.body.data.map((user: { id: string }) => user.id)).toContain(cashier.id);
  });

  it("2. cashier cannot open Users or Settings through the API", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const me = await callApi(cashier.token, "GET", "/me");
    expect(me.body.permissions).not.toContain("users.view");
    expect(me.body.permissions).not.toContain("settings.view");
    for (const [method, path, body] of [
      ["GET", "/users"], ["POST", "/users", {}], ["GET", "/roles"], ["POST", "/roles", { name: "Escalated", permissionKeys: ["users.manage"] }],
      ["GET", "/settings"], ["PUT", "/settings", {}], ["GET", "/audit-log"], ["PUT", "/business", { tradeName: "Hijacked" }],
    ] as const) {
      const response = await callApi(cashier.token, method, path, { body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
    }
  });

  it("3. PIN switch changes the active user and the audit log shows both logins", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const onTerminal = { terminalId: business.terminalId };
    expect((await callApi(business.ownerToken, "POST", "/auth/login-event", onTerminal)).status).toBe(200);
    expect((await callApi(cashier.token, "POST", "/auth/login-event")).status).toBe(200);

    const switched = await callApi(business.ownerToken, "POST", "/auth/pin-switch", {
      ...onTerminal,
      body: { targetEmail: cashier.email, pin: cashier.pin, terminalId: business.terminalId },
    });
    expect(switched.status).toBe(200);
    const asCashier = { ...onTerminal, pinSession: switched.body.pinSession };
    const me = await callApi(business.ownerToken, "GET", "/me", asCashier);
    expect(me.body.activeUserId).toBe(cashier.id);
    expect((await callApi(business.ownerToken, "GET", "/users", asCashier)).status).toBe(403);

    const audit = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    const actions = audit.body.data.map((entry: { action: string; userId: string }) => `${entry.action}:${entry.userId}`);
    expect(actions).toEqual(expect.arrayContaining([
      `login:${business.ownerId}`,
      `login:${cashier.id}`,
      `pin_switch_out:${business.ownerId}`,
      `pin_switch_in:${cashier.id}`,
    ]));
  });

  it("rejects a wrong PIN and locks out after five attempts", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const attempt = () => callApi(business.ownerToken, "POST", "/auth/pin-switch", {
      terminalId: business.terminalId,
      body: { targetEmail: cashier.email, pin: "0000", terminalId: business.terminalId },
    });
    for (let index = 0; index < 5; index += 1) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });
});
