import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedShop } from "./helpers";
import { ROUTE_AUDIT } from "../src/audit/registry.js";

/**
 * A request body that is not a JSON object, or a field of the wrong type, is
 * the caller's mistake. A public route must answer it with a 400. It must not
 * answer 500, write an audit row (a 500 on a declared route is recorded as a
 * failed action), or call console.error (Workers Issues emails the owner about
 * every console.error).
 */

let ipSeq = 0;
/** A fresh address per request, so no per-IP rate limit answers 429 in the route's place. */
function nextIp(): string {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

type Sent = { status: number; body: unknown; rows: string[]; errors: number };

/** One request with a raw body through the real worker; the audit rows it wrote and its console.error calls. */
async function send(method: string, path: string, rawBody: string): Promise<Sent> {
  const last = await env.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request(`https://worker.test${path}`, {
        method,
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
        body: rawBody,
      }) as never,
      env as never,
      ctx as never,
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    const rows = await env.DB.prepare("SELECT action, outcome FROM audit_log WHERE rowid > ? ORDER BY rowid")
      .bind(last!.n)
      .all<{ action: string; outcome: string }>();
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return {
      status: res.status,
      body,
      rows: (rows.results ?? []).map((r) => `${r.action}/${r.outcome}`),
      errors: errorSpy.mock.calls.length,
    };
  } finally {
    errorSpy.mockRestore();
  }
}

const sendJson = (method: string, path: string, value: unknown): Promise<Sent> => send(method, path, JSON.stringify(value));

// Not JSON at all, an empty body, and JSON that is not an object.
const MALFORMED = ["this is not json {", "", "null", "[]", "42", '"text"'];

describe("a body that is not a JSON object", () => {
  it("every declared mutating route answers it below 500, with no audit row and no console.error", async () => {
    const shopId = await seedShop("Malformed Body Shop");
    const keys = Object.keys(ROUTE_AUDIT).sort();
    expect(keys.length).toBeGreaterThan(50);
    const bad: string[] = [];
    let sent = 0;
    for (const key of keys) {
      const [m, p] = key.split(" ");
      const method = m === "ALL" ? "POST" : m!;
      const path = p!.replace(":shopId", shopId).replace(/:[A-Za-z]+/g, "x").replace("/*", "/x");
      for (const raw of MALFORMED) {
        const r = await send(method, path, raw);
        sent += 1;
        if (r.status >= 500 || r.rows.length > 0 || r.errors > 0) {
          bad.push(`${key} ${JSON.stringify(raw)} -> ${r.status} [${r.rows.join(",")}] console.error x${r.errors}`);
        }
      }
    }
    expect(sent).toBe(keys.length * MALFORMED.length);
    expect(bad).toEqual([]);
  }, 300_000);

  it("the public routes answer it 400 'Invalid JSON'", async () => {
    const shopId = await seedShop("Malformed Body Review Shop");
    const routes = ["/api/contact", "/contact", `/api/shops/${shopId}/reviews`, "/auth/login", "/auth/register"];
    const seen: string[] = [];
    for (const path of routes) {
      for (const raw of MALFORMED) {
        const r = await send("POST", path, raw);
        seen.push(`${path} ${JSON.stringify(raw)} -> ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    expect(seen).toEqual(
      routes.flatMap((path) =>
        MALFORMED.map((raw) => `${path} ${JSON.stringify(raw)} -> 400 {"success":false,"error":"Invalid JSON"}`),
      ),
    );
  });
});

describe("a field of the wrong type", () => {
  const enquiry = {
    full_name: "Casey Example",
    shop_name: "Example Cuts",
    shop_type: "barber_shop",
    email: "casey@example.test",
    message: "Hello",
  };

  it.each([
    ["full_name", { ...enquiry, full_name: 123 }, "full_name is required"],
    ["message", { ...enquiry, message: ["Hello"] }, "message is required"],
    ["phone", { ...enquiry, phone: { number: "0123" } }, "phone must be text"],
  ])("contact: %s answers 400 and stores nothing", async (_field, body, error) => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>();
    const r = await sendJson("POST", "/api/contact", body);
    expect(r).toMatchObject({ status: 400, body: { success: false, error }, rows: [], errors: 0 });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("contact still takes a null phone and message, as the contact form sends them", async () => {
    const r = await sendJson("POST", "/api/contact", { ...enquiry, phone: null });
    expect(r).toMatchObject({ status: 201, errors: 0 });
  });

  it.each([
    ["email", { email: { address: "a@b.test" }, password: "pw-123456" }],
    ["password", { email: "nobody@example.test", password: { secret: true } }],
  ])("login: %s answers 400 'email and password are required'", async (_field, body) => {
    const r = await sendJson("POST", "/auth/login", body);
    expect(r).toMatchObject({
      status: 400,
      body: { success: false, error: "email and password are required" },
      rows: [],
      errors: 0,
    });
  });

  it.each([
    ["name", { name: 5, email: `n-${crypto.randomUUID()}@example.test`, password: "pw-123456" }, "name is required"],
    ["email", { name: "Casey", email: { a: 1 }, password: "pw-123456" }, "email and password are required"],
    ["password", { name: "Casey", email: `p-${crypto.randomUUID()}@example.test`, password: 123456 }, "email and password are required"],
  ])("register: %s answers 400 and creates nothing", async (_field, body, error) => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_users").first<{ n: number }>();
    const r = await sendJson("POST", "/auth/register", body);
    expect(r).toMatchObject({ status: 400, body: { success: false, error }, rows: [], errors: 0 });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_users").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});
