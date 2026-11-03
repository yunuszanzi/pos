import { describe, expect, it } from "vitest";
import { pinSchema } from "../../shared/schemas/auth";
import { setupBusinessSchema } from "../../shared/schemas/org";
import { settingsSchema } from "../../shared/schemas/settings";
import { roleSchema } from "../../shared/schemas/users";

describe("Foundation input schemas", () => {
  it("accepts only 4 to 6 digit terminal PINs", () => {
    expect(pinSchema.safeParse("1234").success).toBe(true);
    expect(pinSchema.safeParse("123456").success).toBe(true);
    expect(pinSchema.safeParse("123").success).toBe(false);
    expect(pinSchema.safeParse("12a4").success).toBe(false);
  });

  it("requires a valid owner PIN and branch identifier in initial setup", () => {
    const result = setupBusinessSchema.safeParse({
      legalName: "Example Traders",
      tradeName: "Example",
      branchName: "Main",
      branchCode: "KHI",
      locationName: "Store",
      terminalName: "Counter 1",
      documentPrefix: "INV-KHI",
      ownerPin: "2468",
    });
    expect(result.success).toBe(true);
    expect(setupBusinessSchema.safeParse({
      legalName: "Example",
      tradeName: "Example",
      branchName: "Main",
      branchCode: "KHI",
      locationName: "Store",
      terminalName: "Counter 1",
      documentPrefix: "INV",
      ownerPin: "24",
    }).success).toBe(false);
  });

  it("enforces the supported Foundation session and locale settings", () => {
    expect(settingsSchema.parse({}).timezone).toBe("Asia/Karachi");
    expect(settingsSchema.safeParse({
      currency: "USD",
      timezone: "UTC",
      dateFormat: "dd/MM/yyyy",
      amountRounding: 2,
      sessionTimeoutMinutes: 30,
      posSessionTimeoutHours: 12,
    }).success).toBe(false);
  });

  it("rejects duplicated permission assignments in a role", () => {
    expect(roleSchema.safeParse({ name: "Cashier", permissionKeys: ["users.view", "users.view"] }).success).toBe(false);
    expect(roleSchema.safeParse({ name: "Cashier", permissionKeys: ["users.view"] }).success).toBe(true);
  });
});
