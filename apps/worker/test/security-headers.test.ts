import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

describe("API security headers (T4.5)", () => {
  it("sets the standard hardening headers on responses", async () => {
    const res = await dispatch("GET", "/api/shops"); // any route; 401 is fine
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
