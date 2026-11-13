import { Hono } from "hono";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedShop } from "./helpers";
import { dispatch } from "./request";
import { gapRowsFor } from "./audit-helpers";
import type { Env } from "../src/types.js";
import { requestId } from "../src/audit/request-id.js";
import { auditGapGuard, resolveShopParam } from "../src/audit/gap-guard.js";
import { ROUTE_AUDIT, type AuditDeclaration } from "../src/audit/registry.js";

type App = Hono<{ Bindings: Env }>;

/** A fixture app wired with the SAME middleware `src/index.ts` registers
 *  (requestId + auditGapGuard), so these cases never depend on which real
 *  routes are still pending. */
function fixtureApp(setup: (app: App) => void, registry: Record<string, AuditDeclaration> = {}): App {
  const a = new Hono<{ Bindings: Env }>();
  a.use("*", requestId);
  a.use("*", auditGapGuard(registry));
  setup(a);
  a.onError((_err, c) => c.json({ success: false, error: "Internal server error" }, 500));
  return a;
}

async function send(a: App, method: string, path: string): Promise<{ res: Response; rid: string }> {
  const res = await a.request(path, { method }, env);
  const rid = res.headers.get("X-Request-Id");
  expect(rid, `${method} ${path} answered ${res.status} with no X-Request-Id`).toMatch(/.+/);
  return { res, rid: rid! };
}

async function rowsFor(rid: string): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY occurred_at, rowid")
    .bind(rid)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

describe("booking audit gap guard", () => {
  it("a 2xx on a pending route writes one audit.gap with the route pattern, never the path", async () => {
    const a = fixtureApp((x) => x.post("/fx/items/:id", (c) => c.json({ success: true }, 200)), {
      "POST /fx/items/:id": "pending",
    });
    const id = `item-${crypto.randomUUID()}`;
    const { res, rid } = await send(a, "POST", `/fx/items/${id}`);
    expect(res.status).toBe(200);
    const rows = await rowsFor(rid);
    expect(rows.map((r) => r.action)).toEqual(["audit.gap"]);
    expect(rows[0]).toMatchObject({ via: "api", outcome: "succeeded", worker: "pivot-parlor-booking" });
    const details = JSON.parse(rows[0]!.details_json as string) as Record<string, unknown>;
    expect(details).toMatchObject({ method: "POST", route: "/fx/items/:id", status: 200 });
    expect(rows[0]!.details_json).not.toContain(id);
  });

  it("a 4xx on a declared route writes nothing, a 5xx writes the declared action as failed", async () => {
    const registry: Record<string, AuditDeclaration> = { "POST /fx/declared": "booking.create" };
    const refused = fixtureApp((x) => x.post("/fx/declared", (c) => c.json({ success: false }, 400)), registry);
    const r4 = await send(refused, "POST", "/fx/declared");
    expect(r4.res.status).toBe(400);
    expect(await rowsFor(r4.rid)).toEqual([]);

    const broken = fixtureApp((x) => x.post("/fx/declared", (c) => c.json({ success: false }, 500)), registry);
    const r5 = await send(broken, "POST", "/fx/declared");
    const rows = await rowsFor(r5.rid);
    expect(rows.map((r) => r.action)).toEqual(["booking.create"]);
    expect(rows[0]).toMatchObject({ outcome: "failed", reason: "HTTP 500", phase: "done" });
    expect(await gapRowsFor(r5.rid)).toBe(0);
  });

  it("an exempt route writes nothing", async () => {
    const a = fixtureApp((x) => x.post("/fx/exempt", (c) => c.json({ success: true }, 200)), {
      "POST /fx/exempt": { exempt: "test fixture with a reason" },
    });
    const { res, rid } = await send(a, "POST", "/fx/exempt");
    expect(res.status).toBe(200);
    expect(await rowsFor(rid)).toEqual([]);
  });

  it("a 404 writes nothing", async () => {
    const a = fixtureApp((x) => x.get("/fx/read", (c) => c.json({ success: true })));
    const { res, rid } = await send(a, "POST", "/fx/not/a/route");
    expect(res.status).toBe(404);
    expect(await rowsFor(rid)).toEqual([]);
  });

  it("a route under /webhooks/ records via webhook", async () => {
    const a = fixtureApp((x) => x.post("/webhooks/fx", (c) => c.json({ success: true }, 201)));
    const { rid } = await send(a, "POST", "/webhooks/fx");
    const rows = await rowsFor(rid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "audit.gap", via: "webhook", outcome: "succeeded" });
  });

  it.each([400, 401, 403, 422])("a %i on an undeclared route writes nothing", async (status) => {
    // A refusal changed nothing, and anyone can send one: recording it would
    // let an anonymous caller fill the append-only log at will.
    const a = fixtureApp((x) => x.post("/fx/undeclared-refusal", (c) => c.json({ success: false }, status as 400)));
    const { res, rid } = await send(a, "POST", "/fx/undeclared-refusal");
    expect(res.status).toBe(status);
    expect(await rowsFor(rid)).toEqual([]);
  });

  it("a 4xx on a pending route is still a gap", async () => {
    const a = fixtureApp((x) => x.post("/fx/pending", (c) => c.json({ success: false }, 400)), {
      "POST /fx/pending": "pending",
    });
    const { rid } = await send(a, "POST", "/fx/pending");
    const rows = await rowsFor(rid);
    expect(rows.map((r) => `${String(r.action)}/${String(r.outcome)}`)).toEqual(["audit.gap/refused"]);
  });

  it("finds the declaration when a middleware registered after the handler also matches", async () => {
    // Neither the responding route (the early middleware) nor the last matched
    // route (the late one) is the declared handler.
    const a = fixtureApp(
      (x) => {
        const r = new Hono<{ Bindings: Env }>();
        r.use("*", async (c) => c.json({ success: false }, 500));
        r.post("/thing", (c) => c.json({ success: true }, 201));
        r.use("*", async (_c, next) => {
          await next();
        });
        x.route("/fx/late", r);
      },
      { "POST /fx/late/thing": "booking.create" }
    );
    const { res, rid } = await send(a, "POST", "/fx/late/thing");
    expect(res.status).toBe(500);
    const rows = await rowsFor(rid);
    expect(rows.map((r) => r.action), "exactly one entry, of the declared action").toEqual(["booking.create"]);
    expect(rows[0]).toMatchObject({ outcome: "failed", reason: "HTTP 500" });
  });

  it("records a :shopId only once it resolves to a real shop id", async () => {
    // The fixture answers 500: an undeclared 4xx writes nothing, so a 5xx is
    // what still records a gap with the shop it names.
    const shopId = await seedShop("Booking Gap Shop");
    const a = fixtureApp((x) => x.post("/fx/shops/:shopId/thing", (c) => c.json({ success: false }, 500)));
    const known = await send(a, "POST", `/fx/shops/${shopId}/thing`);
    const knownRow = (await rowsFor(known.rid))[0]!;
    expect(knownRow.shop_id).toBe(shopId);

    const unknown = await send(a, "POST", "/fx/shops/no-such-shop-0001/thing");
    const unknownRow = (await rowsFor(unknown.rid))[0]!;
    expect(unknownRow.shop_id).toBeNull();
    expect(JSON.parse(unknownRow.details_json as string)).toMatchObject({ shop_param: "unresolved" });
    expect(unknownRow.details_json).not.toContain("no-such-shop-0001");
  });

  it("every response carries a server-generated X-Request-Id, and an inbound one is ignored", async () => {
    const res = await dispatch("GET", "/health", { headers: { "X-Request-Id": "attacker-chosen" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("X-Request-Id")).not.toBe("attacker-chosen");
  });

  it("resolveShopParam returns null for an unknown or malformed id, without a lookup for the malformed one", async () => {
    const shopId = await seedShop("Resolve Param Shop");
    expect(await resolveShopParam(env.DB, shopId)).toBe(shopId);
    expect(await resolveShopParam(env.DB, "no-such-shop-00000000")).toBeNull();

    const spy = vi.spyOn(env.DB, "prepare");
    try {
      expect(await resolveShopParam(env.DB, "a b/c")).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the real booking app mounts the gap guard", () => {
  it("a declared route that answers 5xx before its own entry gets the declared action as failed", async () => {
    // POST /public/bookings reads its body with an unguarded c.req.json(), so
    // a body that is not JSON throws before run() and the app answers 500
    // (pre-existing, unchanged). Only the guard can write a row for it.
    expect(ROUTE_AUDIT["POST /public/bookings"]).toBe("booking.create");
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request("https://booking.test/public/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.91" },
        body: "this is not json {",
      }) as never,
      env as never,
      ctx as never
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    const rid = res.headers.get("X-Request-Id");
    expect(rid, "the 500 carries no X-Request-Id").toMatch(/.+/);
    const rows = await rowsFor(rid!);
    expect(rows.map((r) => r.action), "exactly one entry, of the declared action").toEqual(["booking.create"]);
    expect(rows[0]).toMatchObject({
      outcome: "failed",
      reason: "HTTP 500",
      phase: "done",
      via: "api",
      worker: "pivot-parlor-booking",
      shop_id: null,
    });
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ method: "POST", route: "/public/bookings", status: 500 });
    expect(await gapRowsFor(rid!)).toBe(0);
  });
});

/** One anonymous request through the real worker, and every audit row written
 *  while it ran (found by rowid, so a response without an id still counts). */
async function anonymous(method: string, path: string, body?: unknown): Promise<{ status: number; rows: string[] }> {
  const last = await env.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>();
  const res = await dispatch(method, path, {
    headers: { "CF-Connecting-IP": "192.0.2.80" },
    body: method === "GET" ? undefined : body,
  });
  const rows = await env.DB.prepare("SELECT action, outcome FROM audit_log WHERE rowid > ? ORDER BY rowid")
    .bind(last!.n)
    .all<{ action: string; outcome: string }>();
  return { status: res.status, rows: (rows.results ?? []).map((r) => `${r.action}/${r.outcome}`) };
}

describe("anonymous callers cannot write to the booking audit log", () => {
  it("an unknown path under the auth-guarded /booking router answers 401 and writes nothing", async () => {
    const shopId = await seedShop("Booking Gap Unknown Path Shop");
    const paths = ["/booking/no-such-route", `/booking/shops/${shopId}/no-such-route`, "/booking/platform/no-such-route"];
    const seen: string[] = [];
    for (const path of paths) {
      const { status, rows } = await anonymous("POST", path, { junk: true });
      // 401 proves the router's own auth middleware answered, so the path
      // really reached a guarded router rather than falling through to a 404.
      seen.push(`${path} -> ${status} [${rows.join(",")}]`);
    }
    expect(seen).toEqual(paths.map((p) => `${p} -> 401 []`));
  });

  it("every declared mutating route, called anonymously with a junk body, writes nothing", async () => {
    const shopId = await seedShop("Booking Gap Declared Route Shop");
    const keys = Object.keys(ROUTE_AUDIT).sort();
    expect(keys.length).toBeGreaterThan(10);
    const wrote: string[] = [];
    for (const key of keys) {
      const [m, p] = key.split(" ");
      const method = m === "ALL" ? "POST" : m!;
      const path = p!.replace(":shopId", shopId).replace(/:[A-Za-z]+/g, "x").replace("/*", "/x");
      const { status, rows } = await anonymous(method, path, { junk: true });
      if (rows.length > 0) wrote.push(`${key} -> ${status} [${rows.join(",")}]`);
    }
    expect(wrote).toEqual([]);
  }, 120_000);
});
