/**
 * Website server errors (WebErrors entrypoint). The website (Pages Functions)
 * has no Workers Issues of its own, so it hands each server error to this
 * named entrypoint over a service binding; logging it here with console.error
 * opens an issue on pivot-parlor-api and emails the owner
 * (docs/runbooks/production-alerting.md). A named entrypoint is reachable only
 * through a binding, never from the internet.
 */
import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebErrors } from "../src/web-errors";
import worker from "../src/index";
import * as entry from "../src/index";

const reporter = (bindings: unknown = env) => new WebErrors(createExecutionContext() as never, bindings as never);

let seq = 0;
/** A unique route per test, so the shared rate limiter never bleeds between tests. */
const route = (base = "/book/:shopSlug") => `${base}/t${++seq}`;

const sample = (over: Record<string, unknown> = {}) => ({
  where: "page",
  method: "GET",
  route: route(),
  name: "TypeError",
  message: "Cannot read properties of undefined (reading 'name')",
  frames: ["at loader (index.js:1200:15)", "at callRouteLoader (index.js:5300:2)"],
  ...over,
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});
const webLines = () => errors.mock.calls.filter((c) => String(c[0]).startsWith("[web]"));

describe("WebErrors.report", () => {
  it("logs one error, the kind and route in the message, the details as strings", async () => {
    const input = sample();
    const res = await reporter().report(input);
    expect(res).toEqual({ logged: true });
    expect(webLines()).toEqual([
      [
        `[web] TypeError in page GET ${input.route}`,
        {
          detail: "Cannot read properties of undefined (reading 'name')",
          frames: "at loader (index.js:1200:15) | at callRouteLoader (index.js:5300:2)",
        },
      ],
    ]);
  });

  it("keeps its title: the details carry no `message` key", async () => {
    // Workers Logs takes an object's `message` as the event and drops the
    // string before it: on staging 2026-11-12 the "[web] ..." title vanished
    // and only the error text was left, so Issues would have titled the email
    // with it. The CSP reporter's details have no such key and keep theirs.
    await reporter().report(sample());
    const [[title, details]] = webLines();
    expect(String(title).startsWith("[web] TypeError in page GET /")).toBe(true);
    expect(Object.keys(details as object)).not.toContain("message");
  });

  it("masks emails, tokens, ids and long numbers again, in case the website missed one", async () => {
    await reporter().report(
      sample({
        message:
          "no booking for jane.doe@example.com token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123 id 3f2b9c1e-8a7d-4e5f-9b0c-1d2e3f4a5b6c phone 07700900123",
      }),
    );
    const [[, details]] = webLines();
    const message = (details as { detail: string }).detail;
    expect(message).not.toMatch(/jane|eyJ|3f2b9c1e|07700900123/);
    expect(message).toContain("<email>");
    expect(message).toContain("<token>");
    expect(message).toContain("<id>");
    expect(message).toContain("<number>");
  });

  it("keeps only what the fields may hold, whatever it is sent", async () => {
    await reporter().report({
      where: "somewhere",
      method: "get; drop",
      route: "no-leading-slash",
      name: "<img src=x>",
      message: 42,
      frames: "not a list",
    });
    expect(webLines()).toEqual([["[web] Error in unknown UNKNOWN unknown", { detail: "none", frames: "none" }]]);
  });

  it("caps the message and the stack lines", async () => {
    const long = "x ".repeat(400);
    await reporter().report(sample({ message: long, frames: Array.from({ length: 9 }, (_, i) => `at f${i} (${"y".repeat(300)})`) }));
    const [[, details]] = webLines();
    const d = details as { detail: string; frames: string };
    expect(d.detail.length).toBeLessThanOrEqual(300);
    expect(d.frames.split(" | ")).toHaveLength(5);
    for (const f of d.frames.split(" | ")) expect(f.length).toBeLessThanOrEqual(160);
  });

  it("ignores anything that is not a report object", async () => {
    for (const bad of [null, "boom", 7, []]) expect(await reporter().report(bad)).toEqual({ logged: false });
    expect(webLines()).toEqual([]);
  });

  it("rate-limits by kind and route: past the limit it stops logging that error", async () => {
    const r = route("/dev/shops/:shopId");
    const results: boolean[] = [];
    for (let i = 0; i < 31; i++) results.push((await reporter().report(sample({ route: r }))).logged);
    expect(results.slice(0, 30).every(Boolean)).toBe(true);
    expect(results[30]).toBe(false);
    expect(webLines()).toHaveLength(30);
    // Another route is unaffected.
    expect((await reporter().report(sample())).logged).toBe(true);
  });

  it("answers 404 to a plain fetch", async () => {
    const res = await reporter().fetch(new Request("https://worker.test/anything"));
    expect(res.status).toBe(404);
  });
});

describe("WebErrors.reportBrowser", () => {
  // Browser errors reach the website from anyone's browser, so the title is
  // built only from known values: a forged report cannot invent new titles
  // (each new title is a new issue and a new email).
  let ipSeq = 0;
  const ip = () => `198.51.100.${++ipSeq}`;
  const browser = (over: Record<string, unknown> = {}) => ({
    kind: "script",
    route: `routes/t${++seq}`,
    name: "TypeError",
    message: "Cannot read properties of null (reading 'focus')",
    frames: ["at onClick (contact-AbC123.js:1:2345)", "at HTMLButtonElement.dispatch (entry.client-XyZ.js:9:87)"],
    ip: ip(),
    ...over,
  });
  const browserLines = () => errors.mock.calls.filter((c) => String(c[0]).startsWith("[browser]"));

  it("logs one error titled by type, kind and route, the details as strings without a `message` key", async () => {
    const input = browser({ route: "routes/contact" });
    expect(await reporter().reportBrowser(input)).toEqual({ logged: true });
    expect(browserLines()).toEqual([
      [
        "[browser] TypeError in script on routes/contact",
        {
          detail: "Cannot read properties of null (reading 'focus')",
          frames: "at onClick (contact-AbC123.js:1:2345) | at HTMLButtonElement.dispatch (entry.client-XyZ.js:9:87)",
        },
      ],
    ]);
  });

  it("builds the title only from known values, whatever it is sent", async () => {
    await reporter().reportBrowser(browser({ kind: "anything", route: "routes/x\nInjected title", name: "EvilName" }));
    await reporter().reportBrowser(browser({ kind: "hydration", route: "root", name: "BrowserAlertTestError" }));
    await reporter().reportBrowser(browser({ kind: "promise", route: "routes/$shopSlug.book", name: "DOMException" }));
    expect(browserLines().map((c) => c[0])).toEqual([
      "[browser] Error in unknown on unknown",
      "[browser] BrowserAlertTestError in hydration on root",
      "[browser] DOMException in promise on routes/$shopSlug.book",
    ]);
  });

  it("masks the message and caps the stack lines", async () => {
    await reporter().reportBrowser(
      browser({
        message: "no booking for jane.doe@example.com id 3f2b9c1e-8a7d-4e5f-9b0c-1d2e3f4a5b6c " + "x ".repeat(300),
        frames: Array.from({ length: 9 }, (_, i) => `at f${i} (${"y".repeat(300)})`),
      }),
    );
    const [[, details]] = browserLines();
    const d = details as { detail: string; frames: string };
    expect(d.detail).not.toMatch(/jane|3f2b9c1e/);
    expect(d.detail.length).toBeLessThanOrEqual(300);
    expect(d.frames.split(" | ")).toHaveLength(5);
    for (const f of d.frames.split(" | ")) expect(f.length).toBeLessThanOrEqual(160);
  });

  it("limits each visitor: past the limit their reports are dropped", async () => {
    const visitor = ip();
    const results: boolean[] = [];
    for (let i = 0; i < 31; i++) results.push((await reporter().reportBrowser(browser({ ip: visitor }))).logged);
    expect(results.slice(0, 30).every(Boolean)).toBe(true);
    expect(results[30]).toBe(false);
    // Another visitor is unaffected.
    expect((await reporter().reportBrowser(browser())).logged).toBe(true);
  });

  it("limits each title: one failing page cannot log without end", async () => {
    const route = `routes/busy${++seq}`;
    const results: boolean[] = [];
    for (let i = 0; i < 31; i++) results.push((await reporter().reportBrowser(browser({ route }))).logged);
    expect(results.slice(0, 30).every(Boolean)).toBe(true);
    expect(results[30]).toBe(false);
  });

  it("ignores anything that is not a report object", async () => {
    for (const bad of [null, "boom", 7, []]) expect(await reporter().reportBrowser(bad)).toEqual({ logged: false });
    expect(browserLines()).toEqual([]);
  });
});

describe("the API worker", () => {
  it("exports the WebErrors entrypoint the website binds to", () => {
    expect((entry as Record<string, unknown>).WebErrors).toBe(WebErrors);
  });

  it("does not answer it over HTTP (control: there is no such public route)", async () => {
    const request = new Request("https://worker.test/web-errors", { method: "POST", body: "{}" });
    const res = await worker.fetch(request as never, env as never, createExecutionContext() as never);
    expect(res.status).toBe(404);
  });
});
