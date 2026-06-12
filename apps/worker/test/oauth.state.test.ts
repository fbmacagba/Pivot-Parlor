import { describe, expect, it } from "vitest";
import { buildState, safeRedirect, validateState } from "../src/lib/oauth-state";
import { dispatch } from "./request";

const NOW = 1_700_000_000_000;

function freshState(redirectTo: string, nonce = "nonce-1"): string {
  return btoa(JSON.stringify({ redirectTo, nonce, ts: NOW }));
}

describe("safeRedirect (open redirect, T4.2)", () => {
  it("allows same-origin relative paths", () => {
    expect(safeRedirect("/admin")).toBe("/admin");
    expect(safeRedirect("/account?tab=bookings")).toBe("/account?tab=bookings");
  });

  it("rejects absolute URLs, protocol-relative URLs, and backslash tricks", () => {
    expect(safeRedirect("https://evil.com")).toBe("/");
    expect(safeRedirect("http://evil.com/phish")).toBe("/");
    expect(safeRedirect("//evil.com")).toBe("/");
    expect(safeRedirect("/\\evil.com")).toBe("/");
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
  });
});

describe("validateState (CSRF, T4.3)", () => {
  it("accepts a fresh state whose nonce matches the cookie", () => {
    const result = validateState(freshState("/admin"), "nonce-1", NOW + 1000);
    expect(result).toEqual({ ok: true, redirectTo: "/admin" });
  });

  it("rejects an expired state (>10 minutes)", () => {
    const result = validateState(freshState("/admin"), "nonce-1", NOW + 11 * 60 * 1000);
    expect(result.ok).toBe(false);
  });

  it("rejects a nonce mismatch and a missing cookie", () => {
    expect(validateState(freshState("/admin"), "other-nonce", NOW).ok).toBe(false);
    expect(validateState(freshState("/admin"), undefined, NOW).ok).toBe(false);
  });

  it("rejects malformed and legacy (nonce-less) states", () => {
    expect(validateState("garbage!!!", "nonce-1", NOW).ok).toBe(false);
    const legacy = btoa(JSON.stringify({ redirectTo: "/admin", ts: NOW }));
    expect(validateState(legacy, "nonce-1", NOW).ok).toBe(false);
  });

  it("sanitizes a hostile redirectTo inside an otherwise valid state", () => {
    const result = validateState(freshState("https://evil.com"), "nonce-1", NOW);
    expect(result).toEqual({ ok: true, redirectTo: "/" });
  });

  it("buildState round-trips through validateState", () => {
    const state = buildState("/staff", "my-nonce");
    const result = validateState(state, "my-nonce", Date.now());
    expect(result).toEqual({ ok: true, redirectTo: "/staff" });
  });
});

describe("OAuth callback state enforcement (route level)", () => {
  for (const provider of ["google", "facebook", "linkedin"]) {
    it(`${provider} callback rejects a garbage state before any token exchange`, async () => {
      const res = await dispatch("GET", `/auth/${provider}/callback?code=x&state=garbage`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/state/i);
    });

    it(`${provider} initiation sets the nonce cookie and embeds state`, async () => {
      const res = await dispatch("GET", `/auth/${provider}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("Set-Cookie")).toContain("pp_oauth_nonce=");
      const location = new URL(res.headers.get("Location")!);
      expect(location.searchParams.get("state")).toBeTruthy();
    });
  }
});
