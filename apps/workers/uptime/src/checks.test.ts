import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_DETAIL, buildChecks, runAll, runCheck, type Fetcher } from "./checks";
import worker, { runScheduled } from "./index";

const env = { SITE_ORIGIN: "https://site.test", API_ORIGIN: "https://api.test", DEMO_SHOP_SLUG: "demo-shop" };
const NOW = new Date("2026-11-11T12:00:00Z");
const noSleep = async () => {};

function html(status = 200, headers: Record<string, string> = {}): Response {
  return new Response("<html></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'", ...headers },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const HEALTHY: Record<string, () => Response> = {
  "https://site.test/": () => html(),
  "https://site.test/login": () => html(),
  "https://site.test/demo-shop": () => html(),
  "https://api.test/auth/me": () => json({ success: false, error: "Unauthorized" }, 401),
  "https://api.test/api/shops/demo-shop": () => json({ success: true, data: { id: "shop-1" } }),
  "https://api.test/api/shops/shop-1/services": () => json({ success: true, data: [{ id: "svc-1" }, { id: "svc-2" }] }),
  "https://api.test/api/shops/shop-1/slots?date=2026-11-12&service_id=svc-1": () => json({ success: true, data: [] }),
};

/** Production, healthy except where a route is overridden. An unknown URL throws. */
function production(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const route = overrides[url] ?? HEALTHY[url];
    if (!route) throw new Error(`unexpected URL ${url}`);
    return route();
  };
  return { fetcher, calls };
}

const byName = (results: Awaited<ReturnType<typeof runAll>>) => Object.fromEntries(results.map((r) => [r.name, r]));

describe("uptime checks", () => {
  it("passes every check on a healthy production", async () => {
    const { fetcher, calls } = production();
    const results = await runAll(env, fetcher, { now: NOW, sleep: noSleep });
    expect(results.map((r) => r.name)).toEqual(["site-home", "site-login", "site-shop", "api-auth", "booking-slots"]);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    // Slots are asked for tomorrow (UTC) with the shop's first service.
    expect(calls.map((c) => c.url)).toContain("https://api.test/api/shops/shop-1/slots?date=2026-11-12&service_id=svc-1");
  });

  it("fails the home page when our CSP header is missing: a static fallback is not the app", async () => {
    const { fetcher } = production({ "https://site.test/": () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) });
    const r = byName(await runAll(env, fetcher, { now: NOW, sleep: noSleep }))["site-home"];
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Content-Security-Policy/);
  });

  it("fails a page on an error status, and never follows a redirect", async () => {
    const { fetcher, calls } = production({
      "https://site.test/login": () => new Response(null, { status: 302, headers: { location: "/elsewhere" } }),
      "https://site.test/demo-shop": () => html(500),
    });
    const r = byName(await runAll(env, fetcher, { now: NOW, sleep: noSleep }));
    expect(r["site-login"]).toMatchObject({ ok: false, detail: "HTTP 302 (want 200)" });
    expect(r["site-shop"]).toMatchObject({ ok: false, detail: "HTTP 500 (want 200)" });
    expect(calls.every((c) => c.init?.redirect === "manual")).toBe(true);
  });

  it("fails a page that is not HTML", async () => {
    const { fetcher } = production({ "https://site.test/login": () => json({ ok: true }) });
    expect(byName(await runAll(env, fetcher, { now: NOW, sleep: noSleep }))["site-login"].detail).toMatch(/not HTML/);
  });

  it("needs the API's JSON 401 refusal, not just any answer", async () => {
    for (const answer of [() => html(200), () => json({ success: false }, 500), () => new Response("Unauthorized", { status: 401 })]) {
      const { fetcher } = production({ "https://api.test/auth/me": answer });
      expect(byName(await runAll(env, fetcher, { now: NOW, sleep: noSleep }))["api-auth"].ok).toBe(false);
    }
  });

  it("fails the booking check when slots are refused, and passes on a closed day (empty list)", async () => {
    const slots = "https://api.test/api/shops/shop-1/slots?date=2026-11-12&service_id=svc-1";
    const refused = production({ [slots]: () => json({ success: false, error: "boom" }, 500) });
    expect(byName(await runAll(env, refused.fetcher, { now: NOW, sleep: noSleep }))["booking-slots"]).toMatchObject({
      ok: false,
      detail: "slots: HTTP 500 (want 200)",
    });
    const notAList = production({ [slots]: () => json({ success: true, data: { slots: [] } }) });
    expect(byName(await runAll(env, notAList.fetcher, { now: NOW, sleep: noSleep }))["booking-slots"].detail).toMatch(/not a list/);
  });

  it("fails the booking check when the demo shop is missing or has no services", async () => {
    const missing = production({ "https://api.test/api/shops/demo-shop": () => json({ success: false, error: "Shop not found" }, 404) });
    expect(byName(await runAll(env, missing.fetcher, { now: NOW, sleep: noSleep }))["booking-slots"].detail).toBe("shop: HTTP 404 (want 200)");
    const empty = production({ "https://api.test/api/shops/shop-1/services": () => json({ success: true, data: [] }) });
    expect(byName(await runAll(env, empty.fetcher, { now: NOW, sleep: noSleep }))["booking-slots"].detail).toMatch(/no services/);
  });

  it("treats a check that fails once and then passes as healthy", async () => {
    let n = 0;
    const flaky: Fetcher = async () => {
      n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      return html();
    };
    const [home] = buildChecks(env, NOW);
    const r = await runCheck(home, flaky, { attempts: 3, sleep: noSleep });
    expect(r).toMatchObject({ name: "site-home", ok: true, attempts: 2 });
  });

  it("reports the last reason after every attempt fails", async () => {
    const down: Fetcher = async () => html(503);
    const [home] = buildChecks(env, NOW);
    const r = await runCheck(home, down, { attempts: 3, sleep: noSleep });
    expect(r).toMatchObject({ ok: false, attempts: 3, detail: "HTTP 503 (want 200)" });
  });

  it("gives a short reason for a timeout or a network error", async () => {
    const [home] = buildChecks(env, NOW);
    const timeout: Fetcher = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    expect((await runCheck(home, timeout, { attempts: 1, sleep: noSleep })).detail).toBe("timed out");
    const network: Fetcher = async () => {
      throw new TypeError("fetch failed: some long internal message");
    };
    expect((await runCheck(home, network, { attempts: 1, sleep: noSleep })).detail).toBe("network error (TypeError)");
  });

  it("adds the deliberate-failure control only when asked, and it fails against a healthy site", async () => {
    expect(buildChecks(env, NOW).map((c) => c.name)).not.toContain("control-deliberate-failure");
    const { fetcher, calls } = production();
    const results = byName(await runAll({ ...env, CONTROL_FAIL: "true" }, fetcher, { now: NOW, sleep: noSleep }));
    expect(results["control-deliberate-failure"]).toMatchObject({ ok: false, detail: CONTROL_DETAIL });
    expect(Object.values(results).filter((r) => !r.ok).map((r) => r.name)).toEqual(["control-deliberate-failure"]);
    // The control asks production for nothing, so it can never stand in for a real outage.
    const plain = production();
    await runAll(env, plain.fetcher, { now: NOW, sleep: noSleep });
    expect(calls).toHaveLength(plain.calls.length);
  });

  it("gives the control a reason no real check produces, so it never shares an issue with an outage", async () => {
    // Workers Issues groups errors by message with the check name masked, so a
    // control reading "HTTP 404 (want 200)" joined the issue a real missing
    // page would join, and silenced that outage's email for an hour.
    expect(CONTROL_DETAIL).not.toMatch(/HTTP \d{3}|timed out|network error|not HTML|Content-Security-Policy|shop:|services:|slots:/);
  });
});

describe("uptime scheduled run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("logs one error per failing check, naming it, and no error when healthy", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetcher } = production({ "https://site.test/login": () => html(503) });
    await runScheduled(env, fetcher, { now: NOW, sleep: noSleep });
    expect(errors).toHaveBeenCalledTimes(1);
    const [logged] = errors.mock.calls[0];
    expect(logged).toBeInstanceOf(Error);
    expect((logged as Error).message).toBe("Uptime check failed: site-login: HTTP 503 (want 200)");

    errors.mockClear();
    await runScheduled(env, production().fetcher, { now: NOW, sleep: noSleep });
    expect(errors).not.toHaveBeenCalled();
  });

  it("the cron handler runs the checks with the global fetch", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { fetcher, calls } = production();
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => fetcher(url, init));
    await worker.scheduled({} as ScheduledController, env);
    expect(calls.length).toBeGreaterThanOrEqual(7);
    expect(errors).not.toHaveBeenCalled();
    expect(logs).toHaveBeenCalled();
  });
});
