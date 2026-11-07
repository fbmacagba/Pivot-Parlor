// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER, createApiAwareFetch, originOf, type ApiRoute } from "./apiTransport";

const API = "https://api.pivotparlor.com";

function setup(route: Partial<ApiRoute> | undefined) {
  const binding = { fetch: vi.fn<(req: Request) => Promise<Response>>(async () => new Response("from-binding")) };
  const baseFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response("from-base")
  );
  const warn = vi.fn();
  const full: ApiRoute | undefined =
    route === undefined ? undefined : { binding, origin: API, clientIp: "198.51.100.7", ...route };
  const f = createApiAwareFetch(baseFetch as unknown as typeof fetch, () => full, warn);
  return { f, binding, baseFetch, warn };
}

describe("createApiAwareFetch", () => {
  it("sends an API call over the binding with the visitor's IP, keeping method, URL, headers and body", async () => {
    const { f, binding, baseFetch } = setup({});
    const res = await f(`${API}/api/bookings`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await res.text()).toBe("from-binding");
    expect(baseFetch).not.toHaveBeenCalled();
    const sent = binding.fetch.mock.calls[0]![0];
    expect(sent.url).toBe(`${API}/api/bookings`);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("Authorization")).toBe("Bearer t");
    expect(sent.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.7");
    expect(await sent.json()).toEqual({ a: 1 });
  });

  it("replaces a caller-set client IP with the visitor's", async () => {
    const { f, binding } = setup({});
    await f(`${API}/auth/login`, { method: "POST", headers: { [CLIENT_IP_HEADER]: "203.0.113.99" } });
    expect(binding.fetch.mock.calls[0]![0].headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.7");
  });

  it("drops a caller-set client IP when the visitor's is unknown", async () => {
    const { f, binding } = setup({ clientIp: null });
    await f(`${API}/auth/login`, { method: "POST", headers: { [CLIENT_IP_HEADER]: "203.0.113.99" } });
    expect(binding.fetch.mock.calls[0]![0].headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("reroutes a Request object aimed at the API, body intact", async () => {
    const { f, binding } = setup({});
    await f(new Request(`${API}/api/shops/x/upload-image`, { method: "POST", body: "bytes" }));
    const sent = binding.fetch.mock.calls[0]![0];
    expect(sent.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.7");
    expect(await sent.text()).toBe("bytes");
  });

  it("leaves other origins to the normal fetch, passing the same arguments through", async () => {
    const { f, binding, baseFetch } = setup({});
    const init = { method: "POST", body: "x" };
    await f("https://openrouter.ai/api/v1/chat/completions", init);
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/chat/completions", init);
  });

  it("does not spend a streamed body bound for another origin", async () => {
    const { f, baseFetch } = setup({});
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });
    const req = new Request("https://example.com/upload", { method: "POST", body, duplex: "half" } as RequestInit);
    await f(req);
    const passed = baseFetch.mock.calls[0]![0] as Request;
    expect(passed).toBe(req);
    expect(passed.bodyUsed).toBe(false);
    expect(await passed.text()).toBe("streamed");
  });

  it("does not match a host that only starts with the API origin", async () => {
    const { f, binding, baseFetch } = setup({});
    await f("https://api.pivotparlor.com.evil.example/api/x");
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("does nothing outside a request it is serving", async () => {
    const { f, binding, baseFetch } = setup(undefined);
    await f(`${API}/api/x`);
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("does nothing when API_URL is unset", async () => {
    const { f, binding } = setup({ origin: "" });
    await f(`${API}/api/x`);
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it("falls back to the normal fetch without a binding, and warns once", async () => {
    const { f, baseFetch, warn } = setup({ binding: undefined });
    await f(`${API}/api/a`);
    await f(`${API}/api/b`);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("no API service binding");
  });

  it("leaves relative URLs alone", async () => {
    const { f, binding, baseFetch } = setup({});
    await f("/api/shops/x/reviews");
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledOnce();
  });
});

describe("originOf", () => {
  it("returns the origin of an absolute URL and '' otherwise", () => {
    expect(originOf("https://api.pivotparlor.com/x?y=1")).toBe(API);
    expect(originOf("https://pivot-parlor-api-staging.bmorris0565.workers.dev")).toBe(
      "https://pivot-parlor-api-staging.bmorris0565.workers.dev"
    );
    expect(originOf("/relative")).toBe("");
    expect(originOf(undefined)).toBe("");
    expect(originOf("")).toBe("");
  });
});
