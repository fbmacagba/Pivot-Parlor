import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, isAuditAction } from "../src/actions";

describe("action catalogue", () => {
  it("accepts catalogue actions and rejects others", () => {
    expect(isAuditAction("site.pause")).toBe(true);
    expect(isAuditAction("site.explode")).toBe(false);
    expect(isAuditAction(42)).toBe(false);
  });
  it("has no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
