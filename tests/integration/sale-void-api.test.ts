// @vitest-environment node
import { describe, expect, it } from "vitest";
import { callApi, createTestBusiness, hasLocalStack, inviteStaffWithPermissions } from "./helpers";

const integration = describe.skipIf(!hasLocalStack);

// FR-SAL-10: a sale given up before payment is logged with who gave it up and why. Nothing is posted.

integration("giving up a sale before payment", { timeout: 120_000 }, () => {
  it("is written to the audit log with the reason and what was in the cart", async () => {
    const business = await createTestBusiness();
    const cashier = await inviteStaffWithPermissions(business, "Void cashier", ["sales.create", "sales.void"]);
    const voided = await callApi(cashier.token, "POST", "/sales/void", {
      terminalId: business.terminalId, body: { reason: "Customer changed their mind", totalPaisa: 1250, lines: [{ sku: "BAL-RED", quantity: "5" }] },
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(201);
    const log = await callApi(business.ownerToken, "GET", "/audit-log?pageSize=100");
    const entry = log.body.data.find((row: { entity: string; action: string }) => row.entity === "sale" && row.action === "void");
    expect(entry).toBeTruthy();
    expect(entry.after).toMatchObject({ reason: "Customer changed their mind", totalPaisa: 1250, lines: [{ sku: "BAL-RED", quantity: "5" }] });
    expect(entry.userId ?? entry.user_id ?? entry.userName ?? entry.user).toBeTruthy();
    const invoices = await callApi(business.ownerToken, "GET", "/sales");
    expect(invoices.body.total).toBe(0);
  });

  it("needs a reason, and is for those allowed to void", async () => {
    const business = await createTestBusiness();
    const allowed = await inviteStaffWithPermissions(business, "Can void", ["sales.void"]);
    expect((await callApi(allowed.token, "POST", "/sales/void", { body: { reason: "", totalPaisa: 100 } })).status).toBe(400);
    expect((await callApi(allowed.token, "POST", "/sales/void", { body: { reason: "no", totalPaisa: 100 } })).status).toBe(400);
    expect((await callApi(allowed.token, "POST", "/sales/void", { body: { reason: "Wrong items", totalPaisa: -5 } })).status).toBe(400);
    const cannot = await inviteStaffWithPermissions(business, "Cannot void", ["sales.create"]);
    expect((await callApi(cannot.token, "POST", "/sales/void", { body: { reason: "Wrong items", totalPaisa: 100 } })).status).toBe(403);
  });
});
