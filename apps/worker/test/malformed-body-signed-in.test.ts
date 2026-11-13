import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedShop, seedUser, tokenFor } from "./helpers";
import { ROUTE_AUDIT } from "../src/audit/registry.js";

/**
 * The signed-in twin of malformed-body.test.ts. A body that is not a JSON
 * object is the caller's mistake, whoever the caller is. A route must answer
 * it below 500. A 500 records the action as failed in the audit log and calls
 * console.error, which Workers Issues emails to the owner.
 *
 * Every request gets its own shop, its own user and its own session, so no
 * route can hide another: a shop delete earlier in the run cannot turn later
 * routes into 404s, and a logout cannot turn them into 401s. A run where
 * every request answered 401 would look clean, so the reach check below
 * fails on any 401.
 */

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.79.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

type Role = "developer" | "staff" | "customer";

/** The role that can reach a route: staff-only and customer-only routes refuse a developer. */
function roleFor(path: string): Role {
  if (path.startsWith("/api/staff/me")) return "staff";
  if (path.startsWith("/api/me/bookings")) return "customer";
  return "developer";
}

async function signedIn(role: Role): Promise<{ shopId: string; token: string }> {
  const shopId = await seedShop("Signed-in Malformed Shop");
  const scope = role === "developer" ? null : shopId;
  const userId = await seedUser(role, scope);
  if (role === "staff") {
    await env.DB.prepare("INSERT INTO staff (id, shop_id, user_id, display_name) VALUES (?, ?, ?, 'Sweep Staff')")
      .bind(crypto.randomUUID(), shopId, userId)
      .run();
  }
  return { shopId, token: await tokenFor(userId, role, scope) };
}

type Sent = { status: number; failedRows: string[]; errors: number };

async function send(method: string, path: string, rawBody: string, token: string): Promise<Sent> {
  const last = await env.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request(`https://worker.test${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": nextIp(),
          Authorization: `Bearer ${token}`,
        },
        body: rawBody,
      }) as never,
      env as never,
      ctx as never,
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    await res.body?.cancel();
    const rows = await env.DB.prepare(
      "SELECT action, outcome FROM audit_log WHERE rowid > ? AND (outcome = 'failed' OR action = 'audit.gap') ORDER BY rowid",
    )
      .bind(last!.n)
      .all<{ action: string; outcome: string }>();
    return {
      status: res.status,
      failedRows: (rows.results ?? []).map((r) => `${r.action}/${r.outcome}`),
      errors: errorSpy.mock.calls.length,
    };
  } finally {
    errorSpy.mockRestore();
  }
}

const MALFORMED = ["this is not json {", "", "null", "[]", "42", '"text"'];

/**
 * Two routes call a service the test environment does not have (the site
 * builder queue, the email provider), so they answer 503 or 502 to any body,
 * valid or not. That is the missing service, not the body: they are listed
 * apart, by exact status and with no console.error, so they cannot hide a 500.
 */
const SERVICE_MISSING_IN_TESTS: Record<string, number> = {
  "POST /api/shops/:shopId/generate-site": 503,
  "POST /auth/resend-verification": 502,
};

describe("a signed-in request whose body is not a JSON object", () => {
  it("every declared mutating route answers it below 500, records no failure and calls no console.error", async () => {
    const keys = Object.keys(ROUTE_AUDIT).sort();
    expect(keys.length).toBeGreaterThan(50);
    const bad: string[] = [];
    const unauthenticated: string[] = [];
    const serviceMissing = new Set<string>();
    let sent = 0;
    for (const key of keys) {
      const [m, p] = key.split(" ");
      const method = m === "ALL" ? "POST" : m!;
      for (const raw of MALFORMED) {
        const { shopId, token } = await signedIn(roleFor(p!));
        const path = p!.replace(":shopId", shopId).replace(/:[A-Za-z]+/g, "x").replace("/*", "/x");
        const r = await send(method, path, raw, token);
        sent += 1;
        if (r.status === 401) unauthenticated.push(`${key} ${JSON.stringify(raw)}`);
        if (r.status === SERVICE_MISSING_IN_TESTS[key] && r.errors === 0) {
          serviceMissing.add(key);
          continue;
        }
        if (r.status >= 500 || r.failedRows.length > 0 || r.errors > 0) {
          bad.push(`${key} ${JSON.stringify(raw)} -> ${r.status} [${r.failedRows.join(",")}] console.error x${r.errors}`);
        }
      }
    }
    expect(sent).toBe(keys.length * MALFORMED.length);
    // Reach: a fresh session per request means nothing here should be refused as signed out.
    expect(unauthenticated).toEqual([]);
    expect(bad).toEqual([]);
    // The exemption is used by exactly the routes it names, so a stale entry shows.
    expect([...serviceMissing].sort()).toEqual(Object.keys(SERVICE_MISSING_IN_TESTS).sort());
  }, 600_000);
});
