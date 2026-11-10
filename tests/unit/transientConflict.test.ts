import { describe, expect, it } from "vitest";
import { isTransientConflict } from "../../server/lib/dbErrors";

describe("isTransientConflict", () => {
  it.each(["40P01", "40001", "55P03"])("treats Postgres error %s as a collision worth retrying", (code) => {
    expect(isTransientConflict({ cause: { code } })).toBe(true);
    expect(isTransientConflict({ code })).toBe(true);
  });

  it("does not hide real failures", () => {
    for (const error of [{ cause: { code: "23505" } }, { cause: { code: "42P01" } }, new Error("boom"), null, undefined, {}]) {
      expect(isTransientConflict(error)).toBe(false);
    }
  });
});
