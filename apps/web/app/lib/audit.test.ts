import { describe, expect, it } from "vitest";
import { actionLabel, auditExportErrorHtml, auditQuery, entryStatus, escapeHtml } from "./audit";

describe("audit page helpers", () => {
  it("keeps only known filters", () => {
    const p = new URLSearchParams("shop_id=s1&action=site.&evil=1&cursor=c");
    expect(auditQuery(p)).toBe("shop_id=s1&action=site.&cursor=c");
  });
  it("derives the status badge", () => {
    expect(entryStatus({ sealed_at: null, archived_at: null })).toEqual({ label: "Pending", variant: "warning" });
    expect(entryStatus({ sealed_at: "x", archived_at: null })).toEqual({ label: "Sealed", variant: "default" });
    expect(entryStatus({ sealed_at: "x", archived_at: "y" })).toEqual({ label: "Archived", variant: "success" });
  });
  it("labels actions in plain words", () => {
    expect(actionLabel("site.pause")).toBe("Site paused");
    expect(actionLabel("brand.new")).toBe("brand.new");
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
