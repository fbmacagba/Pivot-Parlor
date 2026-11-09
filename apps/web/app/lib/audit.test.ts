import { describe, expect, it } from "vitest";
import {
  ACTION_GROUPS,
  actionLabel,
  auditExportErrorHtml,
  auditQuery,
  dateOnlyQuery,
  entryStatus,
  escapeHtml,
  formatAuditDate,
  formatAuditDateTime,
  pipelineActorLabel,
} from "./audit";

describe("audit page helpers", () => {
  it("keeps only known filters", () => {
    const p = new URLSearchParams("shop_id=s1&action=site.&evil=1&cursor=c");
    expect(auditQuery(p)).toBe("shop_id=s1&action=site.&cursor=c");
  });
  it("isolates just the date range for the subject export, which takes no other filter", () => {
    const p = new URLSearchParams("shop_id=s1&from=2026-01-01&to=2026-12-31&actor=a1");
    expect(dateOnlyQuery(p)).toBe("from=2026-01-01&to=2026-12-31");
    expect(dateOnlyQuery(new URLSearchParams("shop_id=s1"))).toBe("");
  });
  it("derives the status badge", () => {
    expect(entryStatus({ sealed_at: null, archived_at: null })).toEqual({ label: "Pending", variant: "warning" });
    expect(entryStatus({ sealed_at: "x", archived_at: null })).toEqual({ label: "Sealed", variant: "default" });
    expect(entryStatus({ sealed_at: "x", archived_at: "y" })).toEqual({ label: "Archived", variant: "success" });
  });
  it("labels actions in plain words", () => {
    expect(actionLabel("site.pause")).toBe("Site paused");
    expect(actionLabel("site.candidate.publish")).toBe("New site version published");
    expect(actionLabel("site.candidate.discard")).toBe("New site version discarded");
    expect(actionLabel("brand.new")).toBe("brand.new");
    // Ruling 57: the nightly now writes audit.anchor after its emails.
    expect(actionLabel("audit.anchor")).toBe("Daily fingerprint emailed");
  });
  it("labels a Plan 2 action", () => {
    expect(actionLabel("inventory.po.receive")).toBe("Stock received");
  });
  it("labels every Plan 3 action", () => {
    const actions = [
      "shop.setup.complete", "day.open", "day.close", "booking.check_in", "booking.checkout",
      "pos.void", "payment.connect.onboard", "payment.connect.sync", "platform.alert.resolve",
    ];
    for (const a of actions) expect(actionLabel(a), a).not.toBe(a);
    expect(actionLabel("day.open")).toBe("Shop opened for the day");
    expect(actionLabel("payment.connect.sync")).toBe("Payout account confirmed");
  });
  it("groups till, opening and closing, and platform alerts", () => {
    const values = ACTION_GROUPS.map((g) => g.value);
    expect(values).toEqual(expect.arrayContaining(["pos.", "day.", "platform."]));
    expect(ACTION_GROUPS.find((g) => g.value === "pos.")!.label).toBe("Till");
    expect(ACTION_GROUPS.find((g) => g.value === "day.")!.label).toBe("Opening and closing");
    expect(ACTION_GROUPS.find((g) => g.value === "platform.")!.label).toBe("Platform alerts");
    expect(values.indexOf("pos.")).toBe(values.indexOf("payment.") + 1);
  });
  it("labels sign-in and sign-out without claiming success (refused rows share the action)", () => {
    expect(actionLabel("auth.login")).toBe("Sign-in");
    expect(actionLabel("auth.logout")).toBe("Sign-out");
  });
  it("renders dates in UK time, not the server's or browser's zone (M6)", () => {
    // 23:30 UTC in British Summer Time is 00:30 the next day in London.
    expect(formatAuditDate("2026-07-01T23:30:00.000Z")).toBe("02/07/2026");
    expect(formatAuditDateTime("2026-07-01T23:30:00.000Z")).toMatch(/^02\/07\/2026,? 00:30:00$/);
    // Winter: London is UTC.
    expect(formatAuditDateTime("2026-01-15T09:05:00.000Z")).toMatch(/^15\/01\/2026,? 09:05:00$/);
  });
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert(1)</script> & "quoted" 'single'`)).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;"
    );
  });
  it("escapes an upstream error message before it reaches the export error page (Ruling 49 — XSS)", () => {
    const html = auditExportErrorHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("pipelineActorLabel", () => {
  it("names who started a system entry", () => {
    expect(pipelineActorLabel({ actor_type: "system", origin_name: "Sam Example", origin_redacted: false })).toBe("System, started by Sam Example");
  });
  it("never names a redacted origin", () => {
    expect(pipelineActorLabel({ actor_type: "system", origin_name: null, origin_redacted: true })).toBe("System, started by Redacted");
  });
  it("labels a system entry with no origin plainly", () => {
    expect(pipelineActorLabel({ actor_type: "system" })).toBe("System");
    expect(pipelineActorLabel({ actor_type: "system", origin_name: null, origin_redacted: false })).toBe("System");
  });
  it("leaves non-system rows to the page's own label", () => {
    expect(pipelineActorLabel({ actor_type: "user", origin_name: "Sam Example" })).toBeNull();
  });
});
