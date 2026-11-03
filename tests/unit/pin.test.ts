import { describe, expect, it } from "vitest";
import { hashPin, verifyPin } from "../../server/modules/auth/pin";

describe("terminal PIN hashing", () => {
  it("stores a salted hash and verifies only the matching PIN", async () => {
    const hash = await hashPin("2468");
    expect(hash).not.toContain("2468");
    expect(await verifyPin("2468", hash)).toBe(true);
    expect(await verifyPin("8642", hash)).toBe(false);
    expect(await verifyPin("2468", null)).toBe(false);
  });
});
