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

  // The API answers with JSON and images, never a page. A content policy that
  // allows nothing means a response opened as a document (an uploaded SVG, a
  // JSON body a browser sniffs) can run no script and load nothing, and no site
  // can frame it. The permissions line matches the website's.
  it("tells browsers its responses load nothing, can't be framed, and get no device access", async () => {
    for (const path of ["/api/shops", "/health"]) {
      const res = await dispatch("GET", path);
      expect(res.headers.get("Content-Security-Policy"), path).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("Permissions-Policy"), path).toBe("camera=(), microphone=(), geolocation=()");
    }
  });
});
