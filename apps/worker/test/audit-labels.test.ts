import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@repo/audit";
import webAuditLib from "../../web/app/lib/audit.ts?raw";

// apps/web does not depend on @repo/audit, so the check that the Activity page
// labels every catalogue action lives here, reading the web source as text.
describe("Activity labels", () => {
  it("every catalogue action has an Activity label", () => {
    const missing = AUDIT_ACTIONS.filter((a) => !webAuditLib.includes(`"${a}":`));
    expect(missing, `actions with no LABELS entry in apps/web/app/lib/audit.ts: ${missing.join(", ")}`).toEqual([]);
  });
});
