import { describe, expect, it } from "vitest";
import { businessToday } from "../../shared/dates";

describe("businessToday", () => {
  it("uses the business timezone, so just after midnight in Karachi is already the new day", () => {
    expect(businessToday("Asia/Karachi", new Date("2026-11-10T19:30:00Z"))).toBe("2026-11-11");
  });
  it("still the same day in Karachi before midnight there", () => {
    expect(businessToday("Asia/Karachi", new Date("2026-11-10T18:59:00Z"))).toBe("2026-11-10");
  });
});
