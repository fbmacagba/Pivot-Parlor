import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedShop, tokenFor } from "./helpers";
import { ROUTE_AUDIT } from "../src/audit/registry.js";

/**
 * The signed-in twin of malformed-body.test.ts. A body that is not a JSON
 * object must be answered below 500, record no failure and call no
 * console.error (Workers Issues emails the owner about every one), whoever
 * sends it. Every request gets its own shop and its own session, so no route
 * can hide another, and the reach check fails on any 401: a run where every
 * request was refused as signed out would otherwise look clean.
 */

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.80.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

type Sent = { status: number; failedRows: string[]; errors: number };

async function send(method: string, path: string, rawBody: string, token: string): Promise<Sent> {
  const last = await env.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request(`https://booking.test${path}`, {
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

describe("a signed-in request whose body is not a JSON object", () => {
  it("every declared mutating route answers it below 500, records no failure and calls no console.error", async () => {
    const keys = Object.keys(ROUTE_AUDIT).sort();
    expect(keys.length).toBeGreaterThan(10);
    const bad: string[] = [];
    const unauthenticated: string[] = [];
    let sent = 0;
    for (const key of keys) {
      const [m, p] = key.split(" ");
      const method = m === "ALL" ? "POST" : m!;
      for (const raw of MALFORMED) {
        const shopId = await seedShop("Booking Signed-in Malformed Shop");
        const token = await tokenFor("admin", shopId);
        const path = p!.replace(":shopId", shopId).replace(/:[A-Za-z]+/g, "x").replace("/*", "/x");
        const r = await send(method, path, raw, token);
        sent += 1;
        if (r.status === 401) unauthenticated.push(`${key} ${JSON.stringify(raw)}`);
        if (r.status >= 500 || r.failedRows.length > 0 || r.errors > 0) {
          bad.push(`${key} ${JSON.stringify(raw)} -> ${r.status} [${r.failedRows.join(",")}] console.error x${r.errors}`);
        }
      }
    }
    expect(sent).toBe(keys.length * MALFORMED.length);
    expect(unauthenticated).toEqual([]);
    expect(bad).toEqual([]);
  }, 300_000);
});
