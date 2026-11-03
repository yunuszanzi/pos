// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, inviteTestStaff, uniqueEmail } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

integration("user management (FR-USR-03, FR-USR-06)", { timeout: 60_000 }, () => {
  it("stops a manager from changing the owner's PIN, role, status or password", async () => {
    const business = await createTestBusiness();
    const manager = await inviteTestStaff(business, "Manager");
    const ownerPath = `/users/${business.ownerId}`;
    for (const body of [{ pin: "9999" }, { active: false }, { roleId: business.roleIds.Cashier }, { displayName: "Renamed" }]) {
      const response = await callApi(manager.token, "PUT", ownerPath, { body });
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(response.body.error.code).toBe("ROLE_ABOVE_ACTOR");
    }
    expect((await callApi(manager.token, "POST", `${ownerPath}/password-reset`)).status).toBe(403);

    const switchToOwner = await callApi(manager.token, "POST", "/auth/pin-switch", {
      terminalId: business.terminalId,
      body: { targetEmail: business.ownerEmail, pin: "9999", terminalId: business.terminalId },
    });
    expect(switchToOwner.status).toBe(401);
  });

  it("stops a manager from assigning a role with permissions the manager lacks", async () => {
    const business = await createTestBusiness();
    const manager = await inviteTestStaff(business, "Manager");
    const role = await callApi(business.ownerToken, "POST", "/roles", { body: { name: "Role admin", permissionKeys: ["roles.manage"] } });
    expect(role.status).toBe(201);

    const invite = await callApi(manager.token, "POST", "/users", {
      body: { email: uniqueEmail("escalated"), displayName: "Escalated", roleId: role.body.id, branchIds: [business.branchId], pin: "1111" },
    });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe("ROLE_ABOVE_ACTOR");

    const cashier = await inviteTestStaff(business, "Cashier", manager.token);
    const promote = await callApi(manager.token, "PUT", `/users/${cashier.id}`, { body: { roleId: role.body.id } });
    expect(promote.status).toBe(403);
  });

  it("stops a role manager from granting permissions they do not hold", async () => {
    const business = await createTestBusiness();
    const roleAdminRole = await callApi(business.ownerToken, "POST", "/roles", {
      body: { name: "Role admin", permissionKeys: ["roles.view", "roles.manage"] },
    });
    business.roleIds["Role admin"] = roleAdminRole.body.id;
    const roleAdmin = await inviteTestStaff(business, "Role admin");
    const escalate = await callApi(roleAdmin.token, "PUT", `/roles/${roleAdminRole.body.id}`, {
      body: { name: "Role admin", permissionKeys: ["roles.view", "roles.manage", "settings.manage"] },
    });
    expect(escalate.status).toBe(403);
    const create = await callApi(roleAdmin.token, "POST", "/roles", { body: { name: "Shadow", permissionKeys: ["users.manage"] } });
    expect(create.status).toBe(403);
  });

  it("lets a manager deactivate a cashier, which blocks sign-in but keeps history", async () => {
    const business = await createTestBusiness();
    const manager = await inviteTestStaff(business, "Manager");
    const cashier = await inviteTestStaff(business, "Cashier", manager.token);
    expect((await callApi(cashier.token, "POST", "/auth/login-event")).status).toBe(200);

    const deactivate = await callApi(manager.token, "PUT", `/users/${cashier.id}`, { body: { active: false } });
    expect(deactivate.status).toBe(200);
    const blocked = await callApi(cashier.token, "GET", "/me");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("USER_INACTIVE");

    const users = await callApi(business.ownerToken, "GET", "/users");
    expect(users.body.data.find((user: { id: string }) => user.id === cashier.id)?.active).toBe(false);
    const audit = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    expect(audit.body.data.some((entry: { action: string; userId: string }) => entry.action === "login" && entry.userId === cashier.id)).toBe(true);
  });

  it("lets the owner generate a password recovery link for staff", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteTestStaff(business, "Cashier");
    const reset = await callApi(business.ownerToken, "POST", `/users/${cashier.id}/password-reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.recoveryLink).toMatch(/^http/);
  });
});
