/**
 * Public shop images (/assets/:shopSlug/:filename) are embedded cross-origin by
 * the dev dashboard and the live shop sites. The global secureHeaders() defaults
 * Cross-Origin-Resource-Policy to "same-origin", which makes browsers block those
 * <img> loads (the request still returns 200 — CORP is browser-enforced only).
 *
 * These tests assert the targeted fix: assets get CORP "cross-origin" (verified on
 * the real 200 streamed-image path, not the 404 branch), while other routes keep
 * the secureHeaders default "same-origin" — proving the relaxation is scoped.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

describe("public asset CORP (cross-origin embedding)", () => {
  it("serves a real /assets image (200) with Cross-Origin-Resource-Policy: cross-origin", async () => {
    // Seed the simulated R2 bucket at the canonical key the route reads.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
    await env.ASSETS.put("shops/test-corp-shop/logo.png", png, {
      httpMetadata: { contentType: "image/png" },
    });

    const res = await dispatch("GET", "/assets/test-corp-shop/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("serves a staff portrait (200) with Cross-Origin-Resource-Policy: cross-origin", async () => {
    await env.ASSETS.put("staff/test-corp-shop/st-1/avatar.webp", new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer, {
      httpMetadata: { contentType: "image/webp" },
    });
    const res = await dispatch("GET", "/staff/test-corp-shop/st-1/avatar.webp?v=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("keeps Cross-Origin-Resource-Policy: same-origin on the staff API (portrait fix is targeted)", async () => {
    const res = await dispatch("GET", "/api/staff/me");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("keeps Cross-Origin-Resource-Policy: same-origin on non-asset routes (fix is targeted)", async () => {
    const res = await dispatch("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });
});
