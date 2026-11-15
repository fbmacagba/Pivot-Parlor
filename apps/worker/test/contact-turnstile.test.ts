import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

/**
 * The contact form's bot check (Turnstile) runs once, here on the API, so a
 * bot posting straight to the API meets it as well as a visitor using the
 * website (which only forwards the widget's token). A token can be redeemed
 * only once, so the website must not check it too.
 *
 * - With TURNSTILE_SECRET_KEY set, a post needs `turnstile_token`, and
 *   siteverify must accept it before anything is stored.
 * - The fields are checked first, so a typo never spends a visitor's token.
 * - Siteverify unreachable, or refusing our own secret, is our fault: a 503,
 *   and a bad secret logs an error so the "Worker issue" alert fires.
 * - No log line carries the token.
 * - Without the secret (staging, local) the form works as before.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SECRET = "test-turnstile-secret";

let ipSeq = 0;
/** A fresh address per request, so the contact limiter (5 an hour per IP) never answers in the route's place. */
function nextIp(): string {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

const enquiry = {
  full_name: "Casey Example",
  shop_name: "Example Cuts",
  shop_type: "barber_shop",
  email: "casey@example.test",
  message: "Hello",
};

type Verify = { secret: string | null; response: string | null; remoteip: string | null };
type Outcome = { status: number; body: { success?: boolean; error?: string } | null; verifies: Verify[]; stored: number };

/**
 * POSTs `value` to `path` with `secret` as the API's Turnstile secret (none
 * when null). Siteverify answers with `siteverify` (a function of the call,
 * or a thrown error for an unreachable service).
 */
async function post(
  value: unknown,
  opts: { secret?: string | null; siteverify?: () => Response | Promise<Response>; path?: string; ip?: string } = {},
): Promise<Outcome> {
  const verifies: Verify[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SITEVERIFY) return realFetch(input, init);
      const sent = new URLSearchParams(String(init?.body ?? ""));
      verifies.push({ secret: sent.get("secret"), response: sent.get("response"), remoteip: sent.get("remoteip") });
      if (!opts.siteverify) throw new Error("siteverify was called but the test gave it no answer");
      return opts.siteverify();
    }),
  );
  const before = await contactCount();
  const ctx = createExecutionContext();
  const testEnv = opts.secret === null ? { ...env, TURNSTILE_SECRET_KEY: undefined } : { ...env, TURNSTILE_SECRET_KEY: opts.secret ?? SECRET };
  const res = (await worker.fetch(
    new Request(`https://worker.test${opts.path ?? "/api/contact"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": opts.ip ?? nextIp() },
      body: JSON.stringify(value),
    }) as never,
    testEnv as never,
    ctx as never,
  )) as unknown as Response;
  await waitOnExecutionContext(ctx);
  let body: Outcome["body"] = null;
  try {
    body = (await res.json()) as Outcome["body"];
  } catch {
    body = null;
  }
  return { status: res.status, body, verifies, stored: (await contactCount()) - before };
}

async function contactCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>();
  return row!.n;
}

const accepts = () => Response.json({ success: true, "error-codes": [], hostname: "pivotparlor.com" });
const refuses = (code: string) => () => Response.json({ success: false, "error-codes": [code] });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/contact with a Turnstile secret", () => {
  it("stores the enquiry once siteverify accepts the token, sending our secret and the visitor's IP", async () => {
    const r = await post({ ...enquiry, turnstile_token: "tok-good" }, { siteverify: accepts, ip: "203.0.113.9" });
    expect(r.status).toBe(201);
    expect(r.stored).toBe(1);
    expect(r.verifies).toEqual([{ secret: SECRET, response: "tok-good", remoteip: "203.0.113.9" }]);
  });

  it("refuses a post with no token, without calling siteverify", async () => {
    const r = await post(enquiry);
    expect(r).toMatchObject({ status: 400, body: { success: false, error: "Please complete the security check." }, stored: 0 });
    expect(r.verifies).toEqual([]);
  });

  it.each([
    ["an empty token", ""],
    ["a token that is not text", 42],
    ["a token longer than Turnstile issues (2048)", "x".repeat(2049)],
  ])("refuses %s, without calling siteverify", async (_label, token) => {
    const r = await post({ ...enquiry, turnstile_token: token });
    expect(r).toMatchObject({ status: 400, body: { error: "Please complete the security check." }, stored: 0 });
    expect(r.verifies).toEqual([]);
  });

  it.each(["invalid-input-response", "timeout-or-duplicate"])(
    "refuses a token siteverify rejects (%s) and stores nothing",
    async (code) => {
      const r = await post({ ...enquiry, turnstile_token: "tok-bad" }, { siteverify: refuses(code) });
      expect(r).toMatchObject({ status: 400, body: { success: false, error: "Security check failed. Please try again." }, stored: 0 });
      expect(r.verifies).toHaveLength(1);
    },
  );

  it("checks the fields first, so a field mistake does not spend the token", async () => {
    const r = await post({ ...enquiry, shop_type: "not-a-type", turnstile_token: "tok-good" }, { siteverify: accepts });
    expect(r).toMatchObject({ status: 400, body: { error: "Invalid shop_type" }, stored: 0 });
    expect(r.verifies).toEqual([]);
  });

  it("answers 503 and stores nothing when siteverify cannot be reached", async () => {
    const r = await post(
      { ...enquiry, turnstile_token: "tok-good" },
      {
        siteverify: () => {
          throw new TypeError("network down");
        },
      },
    );
    expect(r).toMatchObject({ status: 503, body: { success: false }, stored: 0 });
  });

  it("answers 503 when siteverify itself fails (HTTP 500)", async () => {
    const r = await post({ ...enquiry, turnstile_token: "tok-good" }, { siteverify: () => new Response("oops", { status: 500 }) });
    expect(r).toMatchObject({ status: 503, stored: 0 });
  });

  it("answers 503 and logs an error (so the alert fires) when siteverify refuses our secret", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await post({ ...enquiry, turnstile_token: "tok-good" }, { siteverify: refuses("invalid-input-secret") });
    expect(r).toMatchObject({ status: 503, stored: 0 });
    const logged = errors.mock.calls.flat().map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
    expect(logged.join(" ")).toContain("invalid-input-secret");
  });

  it("never writes the token to a log line", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    // Fictional, and plain words so no secret scanner mistakes it for a key.
    const token = "visitor-token-that-must-stay-out-of-logs";
    await post({ ...enquiry, turnstile_token: token }, { siteverify: refuses("invalid-input-response") });
    await post({ ...enquiry, turnstile_token: token }, { siteverify: refuses("invalid-input-secret") });
    await post({ ...enquiry, turnstile_token: token }, { siteverify: accepts });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("guards the /contact alias the same way", async () => {
    const r = await post(enquiry, { path: "/contact" });
    expect(r).toMatchObject({ status: 400, body: { error: "Please complete the security check." }, stored: 0 });
  });
});

describe("POST /api/contact without a Turnstile secret (staging, local)", () => {
  it("stores the enquiry with no token and calls no siteverify (control)", async () => {
    const r = await post(enquiry, { secret: null });
    expect(r.status).toBe(201);
    expect(r.stored).toBe(1);
    expect(r.verifies).toEqual([]);
  });
});
