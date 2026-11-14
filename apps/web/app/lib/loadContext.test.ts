import { describe, expect, it, vi } from "vitest";
import { webLoadContext, type CloudflareRequestContext } from "./loadContext";

// Loaders get the same load context on Pages (functions/_middleware.ts) and in
// dev (vite.config.ts), built from the Cloudflare request context that both
// Remix 2 and React Router 7 pass as `context.cloudflare`.

function cloudflare(data?: Record<string, unknown>) {
  const waitUntil = vi.fn();
  const cf: CloudflareRequestContext = { env: { API_URL: "https://api.example" }, ctx: { waitUntil }, data };
  return { cf, waitUntil };
}

describe("webLoadContext", () => {
  it("passes env through as the same object", () => {
    const { cf } = cloudflare();
    expect(webLoadContext(cf).env).toBe(cf.env);
  });

  it("forwards waitUntil to ctx.waitUntil with the same promise", () => {
    const { cf, waitUntil } = cloudflare();
    const p = Promise.resolve();
    webLoadContext(cf).waitUntil(p);
    expect(waitUntil).toHaveBeenCalledWith(p);
  });

  it("reads the CSP nonce from data", () => {
    expect(webLoadContext(cloudflare({ cspNonce: "abc" }).cf).cspNonce).toBe("abc");
  });

  it("ignores a nonce that is not a string, or no data at all", () => {
    expect(webLoadContext(cloudflare({ cspNonce: 7 }).cf).cspNonce).toBeUndefined();
    expect(webLoadContext(cloudflare().cf).cspNonce).toBeUndefined();
  });
});
