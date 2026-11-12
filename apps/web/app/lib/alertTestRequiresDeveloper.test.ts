/** The developer dashboard's "Send a test alert" raises one labelled server
 *  error, which app/lib/serverErrors.ts reports to the alert email. Only a
 *  developer may raise it: anyone else is turned away before it throws, so
 *  nobody else can send the owner an alert. Lives in lib/ rather than routes/
 *  so Remix never mounts it as a route. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as route from "~/routes/api.dev.alert-test";
import {
  ALERT_TEST_MESSAGE,
  ALERT_TEST_PATH,
  alertTestOutcome,
  BROWSER_ALERT_TEST_MESSAGE,
  BrowserAlertTestError,
  raiseBrowserAlertTest,
} from "./alertTest";
import { describeServerError } from "./serverErrors";

const API_URL = "https://api.test";
const context = { env: { API_URL } };
const SESSION = "pp_session=tok.abc.123";
const URL_ = "https://pivotparlor.com/api/dev/alert-test";

/** Stubs the API: /auth/me answers as `role` (null: refused). */
function stubApi(role: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      role
        ? Response.json({ success: true, data: { id: "u-1", role, shop_id: null } })
        : Response.json({ success: false, error: "Unauthorized" }, { status: 401 }),
    ),
  );
}

function post(cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return new Request(URL_, { method: "POST", headers });
}

/** What the action threw; fails the test if it returned instead. */
async function thrown(request: Request): Promise<unknown> {
  try {
    await route.action({ request, context, params: {} } as never);
  } catch (e) {
    return e;
  }
  throw new Error("the action returned normally");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.dev.alert-test", () => {
  it("is a resource route: no page, no loader", () => {
    // A default export would make Remix answer with an HTML page (PR #102).
    expect(Object.keys(route).sort()).toEqual(["AlertTestError", "action"]);
  });

  it.each([
    ["customer", "/account"],
    ["admin", "/admin"],
    ["staff", "/staff"],
  ])("turns away role %s without raising the error", async (role, home) => {
    stubApi(role);
    const res = await thrown(post(SESSION));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).headers.get("Location")).toBe(home);
  });

  it("sends a visitor with no session, or a refused one, to sign in", async () => {
    stubApi("developer");
    const anonymous = (await thrown(post())) as Response;
    expect(anonymous.headers.get("Location")).toMatch(/^\/login/);
    stubApi(null);
    const refused = (await thrown(post(SESSION))) as Response;
    expect(refused.headers.get("Location")).toMatch(/^\/login/);
  });

  it("raises the labelled error for a developer (control), which reports as such", async () => {
    stubApi("developer");
    const error = await thrown(post(SESSION));
    expect(error).toBeInstanceOf(route.AlertTestError);
    expect(describeServerError(error, post(SESSION))).toMatchObject({
      where: "action",
      method: "POST",
      route: "/api/dev/alert-test",
      name: "AlertTestError",
      message: "Deliberate test error from the developer dashboard",
    });
  });
});

describe("the dashboard button's outcome", () => {
  it("posts to this route", () => {
    expect(new URL(URL_).pathname).toBe(ALERT_TEST_PATH);
  });

  it("reads Remix's 500 as raised, anything else as not raised", () => {
    // A developer's POST always throws, so Remix answers 500. A sign-in
    // redirect under redirect: "manual" reads as status 0.
    expect(alertTestOutcome(500)).toBe("raised");
    expect(alertTestOutcome(0)).toBe("refused");
    expect(alertTestOutcome(204)).toBe("refused");
    expect(alertTestOutcome(403)).toBe("refused");
    expect(alertTestOutcome(null)).toBe("unreachable");
  });

  it("says what happened in plain words, without dashes", () => {
    expect(ALERT_TEST_MESSAGE.raised).toMatch(/email/);
    for (const text of Object.values(ALERT_TEST_MESSAGE)) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

// "Send a test browser alert" throws in the developer's own browser, which
// app/lib/browserErrors.ts reports like any visitor's error. The page is
// developer-only (dev.tsx), so nobody else has the button.
describe("the browser test alert", () => {
  function raised(): unknown {
    let raise: (() => void) | undefined;
    raiseBrowserAlertTest((fn) => {
      raise = fn;
    });
    if (!raise) throw new Error("nothing was scheduled");
    try {
      raise();
    } catch (e) {
      return e;
    }
    throw new Error("the scheduled function did not throw");
  }

  it("throws one labelled error, later and outside React, as an uncaught error does", () => {
    const error = raised();
    expect(error).toBeInstanceOf(BrowserAlertTestError);
    // A string literal: a minifier renames the class, never this.
    expect((error as Error).name).toBe("BrowserAlertTestError");
    expect((error as Error).message).toBe("Deliberate test error from the developer dashboard, in the browser");
  });

  it("is an error type the API puts in an alert title", () => {
    const worker = readFileSync(path.resolve(__dirname, "../../../worker/src/web-errors.ts"), "utf8");
    const start = worker.indexOf("const BROWSER_NAMES");
    expect(start).toBeGreaterThan(-1);
    expect(worker.slice(start, worker.indexOf("]);", start))).toContain('"BrowserAlertTestError"');
  });

  it("says what happened in plain words, without dashes", () => {
    expect(BROWSER_ALERT_TEST_MESSAGE).toMatch(/email/);
    expect(BROWSER_ALERT_TEST_MESSAGE).not.toMatch(/[\u2013\u2014]/);
  });
});
