import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api";
import { hasUnsafePathSegment, isTraversalApiPath } from "./pathSafety";

// Found on production 2026-11-11: /%5Cexample.com%5C..%5C..%5C..%5C..%5Capi%5Cshops%5Clinden-and-lark-demo
// rendered the Linden shop page (HTTP 200). The decoded slug went into the
// API URL, where `\` and `..` resolved back to a real shop, and every link on
// the page, the PWA manifest included, was built from that slug:
// href="/\example.com\..\..." resolves to https://example.com/...

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasUnsafePathSegment (incoming request paths)", () => {
  it.each([
    "/",
    "/linden-and-lark-demo",
    "/ferdyms-barber-shop-014/book",
    "/assets/entry.client-AbC123.js",
    "/api/shops/0b1c2d3e-aaaa-bbbb-cccc-123456789abc/delete",
    "/caf%C3%A9",
    "/a%20b",
  ])("lets %s through", (p) => {
    expect(hasUnsafePathSegment(p)).toBe(false);
  });

  it.each([
    ["an encoded backslash", "/%5Cexample.com%5C..%5C..%5Capi%5Cshops%5Cx"],
    ["an encoded slash", "/x%2Fy"],
    ["a second encoding layer", "/%252e%252e"],
    ["an encoded tab", "/a%09b"],
    ["an encoded newline", "/a%0Ab"],
    ["an encoded NUL", "/a%00"],
    ["an encoded DEL", "/a%7F"],
    ["an encoded dot segment mixed in", "/x/%2E%2E%5C"],
    ["malformed percent-encoding", "/%E0%A4%A"],
  ])("refuses %s", (_label, p) => {
    expect(hasUnsafePathSegment(p)).toBe(true);
  });
});

describe("isTraversalApiPath (outgoing API paths)", () => {
  it.each([
    "/api/shops/\\example.com\\..\\..\\x",
    "/api/shops/../admin",
    "/api/shops/%2e%2e/admin",
    "/api/shops/.%2E/admin",
    "/api/shops/%2E./admin",
    "/api/shops/./x",
    "/api/shops/%2e/x",
    "/api/shops/a\tb",
    "/api/shops/x\n/../y",
    "/api/shops/x\r",
  ])("flags %j", (p) => {
    expect(isTraversalApiPath(p)).toBe(true);
  });

  it.each([
    "/api/shops/ferdyms-barber-shop-014",
    "/api/shops/abc?next=../x&v=1.2",
    "/api/shops/a.b/c",
    "/api/me/bookings",
  ])("passes %j", (p) => {
    expect(isTraversalApiPath(p)).toBe(false);
  });
});

describe("createApiClient refuses a traversal path", () => {
  it("never fetches it", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(
      createApiClient("https://api.test", "tok").get("/api/shops/\\example.com\\..\\..\\..\\..\\api\\shops\\x"),
    ).rejects.toThrow(/refused/i);
    await expect(createApiClient("https://api.test").post("/api/shops/%2e%2e/admin", {})).rejects.toThrow(/refused/i);
    expect(f).not.toHaveBeenCalled();
  });

  it("still sends ordinary paths, dots in the query included", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: 7 }) }));
    vi.stubGlobal("fetch", f);
    const data = await createApiClient("https://api.test").get<number>("/api/shops/ferdyms-barber-shop-014?next=../x");
    expect(data).toBe(7);
    expect(f).toHaveBeenCalledWith("https://api.test/api/shops/ferdyms-barber-shop-014?next=../x", expect.anything());
  });
});

describe("functions/_middleware.ts", () => {
  it("refuses an unsafe request path before Remix handles it", () => {
    const src = readFileSync(path.resolve(process.cwd(), "functions/_middleware.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*hasUnsafePathSegment[^}]*\} from "\.\.\/app\/lib\/pathSafety"/);
    const check = src.indexOf("hasUnsafePathSegment(new URL(context.request.url).pathname)");
    const handle = src.indexOf("handleRequest(context)");
    expect(check).toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(check);
    expect(src.slice(check, handle)).toMatch(/status: 404/);
  });
});
