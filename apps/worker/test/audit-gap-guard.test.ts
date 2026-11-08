import { Hono } from "hono";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Via } from "@repo/audit";
import worker from "../src/index";
import { seedShop } from "./helpers";
import { dispatch } from "./request";
import { expectNoPersonalData, gapRowsFor } from "./audit-helpers";
import type { Bindings } from "../src/bindings.js";
import { requestId } from "../src/audit/request-id.js";
import { auditGapGuard } from "../src/audit/gap-guard.js";
import { batchWithAudit } from "../src/audit/context.js";
import { ROUTE_AUDIT, type AuditDeclaration } from "../src/audit/registry.js";

type App = Hono<{ Bindings: Bindings }>;

/**
 * A fixture Hono app wired with the SAME middleware `src/index.ts` registers
 * on `app` (requestId + auditGapGuard), so these cases never depend on a real
 * route that a later task instruments. Each fixture route answers with a fixed
 * status. Its paths are under /fx and /fixture, so they are undeclared unless
 * a test passes its own registry.
 */
function fixtureApp(
  setup: (app: App) => void,
  opts: { registry?: Record<string, AuditDeclaration>; via?: Via } = {}
): App {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("*", requestId, auditGapGuard(opts.via ?? "api", opts.registry ?? {}));
  setup(app);
  app.onError((_err, c) => c.json({ success: false, error: "Internal server error" }, 500));
  return app;
}

async function send(
  app: App,
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ res: Response; rid: string }> {
  const res = await app.request(path, { method, headers }, env);
  const rid = res.headers.get("X-Request-Id");
  expect(rid, `${method} ${path} answered ${res.status} with no X-Request-Id`).toMatch(/.+/);
  return { res, rid: rid! };
}

/** Every audit_log row one request left, of any action. */
async function rowsFor(rid: string): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY occurred_at, rowid")
    .bind(rid)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

async function onlyGapFor(rid: string, context: string): Promise<Record<string, unknown>> {
  const rows = (await rowsFor(rid)).filter((r) => r.action === "audit.gap");
  expect(rows.length, `expected exactly one audit.gap row: ${context}`).toBe(1);
  return rows[0]!;
}

async function auditLogCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n;
}

/** Ruling 55 fixture: a mutating route whose pattern carries :shopId. */
const shopRoute = (app: App) => app.delete("/fixture/shops/:shopId/thing", (c) => c.json({ success: false }, 401));

describe("audit gap guard", () => {
  it("records an audit.gap entry for an un-instrumented mutating request", async () => {
    const app = fixtureApp((a) => a.post("/fx/undeclared", (c) => c.json({ success: true }, 201)));
    const { res, rid } = await send(app, "POST", "/fx/undeclared", { "CF-Connecting-IP": "192.0.2.10" });
    const row = await onlyGapFor(rid, `undeclared POST answered ${res.status}`);
    expect(JSON.parse(row.details_json as string)).toMatchObject({ method: "POST", route: "/fx/undeclared", status: res.status });
    expect(row.actor_type).toBe("anonymous");
    expect(row.ip_ref).not.toBeNull();
  });

  it("skips GET requests and unmatched paths", async () => {
    const app = fixtureApp((a) => a.get("/fx/read", (c) => c.json({ success: true }, 200)));
    const before = await auditLogCount();
    const read = await send(app, "GET", "/fx/read");
    const unmatched = await send(app, "POST", "/fx/definitely/not/a/route");
    expect([read.res.status, unmatched.res.status]).toEqual([200, 404]);
    expect(await auditLogCount()).toBe(before);
  });

  it("gives every request an id", async () => {
    const app = fixtureApp((a) => a.get("/fx/read", (c) => c.json({ success: true }, 200)));
    const res = await app.request("/fx/read", {}, env);
    expect(res.headers.get("X-Request-Id")).toMatch(/.+/);
  });

  it("ignores a client-supplied X-Request-Id and records the server id on the audit entry", async () => {
    const app = fixtureApp((a) => a.post("/fx/undeclared", (c) => c.json({ success: true }, 201)));
    const { rid } = await send(app, "POST", "/fx/undeclared", {
      "CF-Connecting-IP": "192.0.2.11",
      "X-Request-Id": "attacker-chosen",
    });
    expect(rid).not.toBe("attacker-chosen");
    expect(await gapRowsFor(rid)).toBe(1);
    expect(await rowsFor("attacker-chosen")).toEqual([]);
  });

  it("writes no audit.gap row for any 429 rate-limited response (count-based, not just-the-last-row)", async () => {
    const app = fixtureApp((a) => a.post("/fx/limited", (c) => c.json({ success: false }, 429)));
    const { res, rid } = await send(app, "POST", "/fx/limited", { "CF-Connecting-IP": "192.0.2.20" });
    expect(res.status).toBe(429);
    expect(await gapRowsFor(rid)).toBe(0);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap' AND json_extract(details_json, '$.status') = 429"
    ).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("records a webhook-via audit.gap entry for a refused webhook POST", async () => {
    const app = fixtureApp((a) => a.post("/fx/webhook", (c) => c.json({ success: false }, 400)), { via: "webhook" });
    const { res, rid } = await send(app, "POST", "/fx/webhook");
    expect(res.status).not.toBe(200);
    const row = await onlyGapFor(rid, `webhook POST answered ${res.status}`);
    expect(row.via).toBe("webhook");
  });

  it("records the matched route pattern, never the raw path (no token leakage)", async () => {
    const app = fixtureApp((a) => a.post("/fx/invites/:token/accept", (c) => c.json({ success: false }, 400)));
    const token = `tok${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const { res, rid } = await send(app, "POST", `/fx/invites/${token}/accept`);
    expect(res.status).toBe(400);
    const row = await onlyGapFor(rid, "token route");
    expect(JSON.parse(row.details_json as string).route).toBe("/fx/invites/:token/accept");
    expect(row.details_json).toContain(":token");
    expect(row.details_json).not.toContain(token);
    expectNoPersonalData(row, [token]);
  });

  it("records the responding router-middleware pattern, never the leaf route or the raw path", async () => {
    // Undeclared (empty registry), so today's gap behaviour applies. The
    // sub-router's own .use("*") answers 401 before the leaf handler runs, so
    // the responding pattern is that middleware's composed ".../*" path.
    const shopId = await seedShop("Gap Responding Shop");
    const app = fixtureApp((a) => {
      const items = new Hono<{ Bindings: Bindings }>();
      items.use("*", async (c, next) => {
        if (!c.req.header("Authorization")) return c.json({ success: false }, 401);
        await next();
      });
      items.put("/:id/status", (c) => c.json({ success: true }, 200));
      a.route("/fx/shops/:shopId/items", items);
    });
    const itemId = `item-${crypto.randomUUID()}`;
    const path = `/fx/shops/${shopId}/items/${itemId}/status`;

    const refused = await send(app, "PUT", path);
    expect(refused.res.status).toBe(401);
    const row = await onlyGapFor(refused.rid, "router middleware answered 401");
    const details = JSON.parse(row.details_json as string) as Record<string, unknown>;
    expect(details.route).toBe("/fx/shops/:shopId/items/*");
    expect(row.outcome).toBe("refused");
    expect(row.shop_id, "Ruling 55: the seeded shop resolves through the middleware's own :shopId").toBe(shopId);
    expect(details).not.toHaveProperty("shop_param");
    expectNoPersonalData(row, [itemId, path]);

    // Control: when the leaf answers, the leaf's pattern is recorded instead,
    // so the assertion above really tells the two apart.
    const answered = await send(app, "PUT", path, { Authorization: "Bearer fixture" });
    expect(answered.res.status).toBe(200);
    const leaf = await onlyGapFor(answered.rid, "leaf answered 200");
    expect(JSON.parse(leaf.details_json as string).route).toBe("/fx/shops/:shopId/items/:id/status");
  });

  it("sets shopId from a :shopId route param when the matched pattern has one", async () => {
    // Ruling 55: only an EXISTING shop's id is recorded.
    const shopId = await seedShop("Gap ShopId Shop");
    const { res, rid } = await send(fixtureApp(shopRoute), "DELETE", `/fixture/shops/${shopId}/thing`);
    expect(res.status).toBe(401);
    const row = await onlyGapFor(rid, "shop id param");
    expect(row.shop_id).toBe(shopId);
    expect(JSON.parse(row.details_json as string).route).toBe("/fixture/shops/:shopId/thing");
    expect(JSON.parse(row.details_json as string)).not.toHaveProperty("shop_param");
  });

  // Ruling 55: the :shopId param is caller-supplied. It is hashed into a
  // 6-year entry only once it has been resolved to a real shops.id.
  it("records the shop's id when :shopId is the shop's slug", async () => {
    const shopId = await seedShop("Gap Slug Shop");
    const { slug } = (await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>())!;
    const { res, rid } = await send(fixtureApp(shopRoute), "DELETE", `/fixture/shops/${slug}/thing`);
    expect(res.status).toBe(401);
    const row = await onlyGapFor(rid, "shop slug param");
    expect(row.shop_id).toBe(shopId);
    expect(row.details_json).not.toContain(slug);
  });

  it.each([
    ["markup", "<script>alert(1)</script>"],
    ["300 characters", "a".repeat(300)],
    ["an id-shaped value with no such shop", "no-such-shop-00000000"],
  ])("records shop_id null and shop_param \"unresolved\" for a hostile :shopId (%s)", async (_label, param) => {
    const { res, rid } = await send(fixtureApp(shopRoute), "DELETE", `/fixture/shops/${encodeURIComponent(param)}/thing`);
    expect(res.status).toBe(401);
    const row = await onlyGapFor(rid, "hostile shop param");
    expect(row.shop_id).toBeNull();
    const details = JSON.parse(row.details_json as string) as Record<string, unknown>;
    expect(details.shop_param).toBe("unresolved");
    expect(details.route).toBe("/fixture/shops/:shopId/thing");
    expect(row.details_json).not.toContain(param);
  });

  it("writes a failed audit.gap entry when a handler throws", async () => {
    const app = fixtureApp((a) =>
      a.post("/fx/throws", () => {
        throw new Error("boom");
      })
    );
    const { res, rid } = await send(app, "POST", "/fx/throws");
    expect(res.status).toBe(500);
    const row = await onlyGapFor(rid, "throwing handler");
    expect(row.outcome).toBe("failed");
    expect(JSON.parse(row.details_json as string)).toMatchObject({ method: "POST", status: 500 });
  });

  it("writes a failed audit.gap entry when batchWithAudit's combined batch fails to commit", async () => {
    const app = fixtureApp((a) =>
      a.post("/fx/batch-fail", async (c) => {
        const badChange = c.env.DB.prepare("INSERT INTO no_such_table (id) VALUES (?)").bind("x");
        const refusal = await batchWithAudit(c, [badChange], { action: "audit.gap", outcome: "succeeded" });
        if (refusal) return refusal;
        return c.json({ success: true }, 201);
      })
    );
    const { res, rid } = await send(app, "POST", "/fx/batch-fail");
    expect(res.status).toBe(500);
    const row = await onlyGapFor(rid, "batch commit failure");
    expect(row.outcome).toBe("failed");
  });

  // Decision 2: the guard reads the registry.
  const declared: Record<string, AuditDeclaration> = { "POST /fx/declared": "service.create" };

  it("a 4xx on a declared route writes nothing", async () => {
    const app = fixtureApp((a) => a.post("/fx/declared", (c) => c.json({ success: false }, 400)), { registry: declared });
    const before = await auditLogCount();
    const { res, rid } = await send(app, "POST", "/fx/declared");
    expect(res.status).toBe(400);
    expect(await auditLogCount()).toBe(before);
    expect(await rowsFor(rid)).toEqual([]);
  });

  it("a 5xx on a declared route records the declared action as failed", async () => {
    const app = fixtureApp((a) => a.post("/fx/declared", (c) => c.json({ success: false }, 500)), { registry: declared });
    const { res, rid } = await send(app, "POST", "/fx/declared");
    expect(res.status).toBe(500);
    const rows = await rowsFor(rid);
    expect(rows.map((r) => r.action), "exactly one entry, of the declared action").toEqual(["service.create"]);
    expect(rows[0]).toMatchObject({ action: "service.create", outcome: "failed", reason: "HTTP 500", phase: "done" });
    expect(JSON.parse(rows[0]!.details_json as string)).toMatchObject({ route: "/fx/declared", status: 500 });
    expect(await gapRowsFor(rid)).toBe(0);
  });

  it("a 2xx on a declared route with no entry is still a gap", async () => {
    const app = fixtureApp((a) => a.post("/fx/declared", (c) => c.json({ success: true }, 200)), { registry: declared });
    const { rid } = await send(app, "POST", "/fx/declared");
    const row = await onlyGapFor(rid, "declared route answered 2xx with no entry");
    expect(row).toMatchObject({ action: "audit.gap", outcome: "succeeded" });
  });

  it("a 4xx on a pending route is still a gap", async () => {
    const app = fixtureApp((a) => a.post("/fx/pending", (c) => c.json({ success: false }, 400)), {
      registry: { "POST /fx/pending": "pending" },
    });
    const { rid } = await send(app, "POST", "/fx/pending");
    const row = await onlyGapFor(rid, "pending route answered 400");
    expect(row).toMatchObject({ action: "audit.gap", outcome: "refused" });
  });

  it("an exempt route writes nothing", async () => {
    const app = fixtureApp((a) => a.post("/fx/exempt", (c) => c.json({ success: true }, 200)), {
      registry: { "POST /fx/exempt": { exempt: "test fixture with a reason" } },
    });
    const { res, rid } = await send(app, "POST", "/fx/exempt");
    expect(res.status).toBe(200);
    expect(await rowsFor(rid)).toEqual([]);
  });

  it("an ALL declaration covers mutating methods", async () => {
    const app = fixtureApp((a) => a.all("/fx/proxy", (c) => c.json({ success: true }, 200)), {
      registry: { "ALL /fx/proxy": { exempt: "pure proxy in the fixture" } },
    });
    const { res, rid } = await send(app, "POST", "/fx/proxy");
    expect(res.status).toBe(200);
    expect(await rowsFor(rid)).toEqual([]);
  });

  it("a 403 from router middleware on a declared route writes no gap", async () => {
    // The responding route is the sub-router's "/fx/items/*" middleware; the
    // declaration is found through the last matched route, the handler's.
    const app = fixtureApp(
      (a) => {
        const items = new Hono<{ Bindings: Bindings }>();
        items.use("*", async (c) => c.json({ success: false }, 403));
        items.put("/:id/status", (c) => c.json({ success: true }, 200));
        a.route("/fx/items", items);
      },
      { registry: { "PUT /fx/items/:id/status": "booking.status" } }
    );
    const { res, rid } = await send(app, "PUT", "/fx/items/item-1/status");
    expect(res.status).toBe(403);
    expect(await rowsFor(rid)).toEqual([]);
  });
});

describe("the real app mounts the gap guard", () => {
  it("an exempt booking proxy on the real app writes no floor row", async () => {
    // POST /api/bookings is a pure proxy to the booking worker, which records
    // the change itself; the BOOKING stub in vitest.config.ts answers it 201.
    expect(ROUTE_AUDIT["POST /api/bookings"]).toMatchObject({ exempt: expect.any(String) });
    const res = await dispatch("POST", "/api/bookings", {
      headers: { "CF-Connecting-IP": "192.0.2.30" },
      body: { shop_slug: "gap-guard-wiring" },
    });
    const rid = res.headers.get("X-Request-Id");
    expect(rid, `POST /api/bookings answered ${res.status} with no X-Request-Id`).toMatch(/.+/);
    expect(res.status).toBe(201);
    expect(await gapRowsFor(rid!), "an exempt route must not write a floor row").toBe(0);
  });

  it("a declared route that answers 5xx before its own entry gets the declared action as failed", async () => {
    // POST /api/contact parses its body inside a try whose catch answers 500
    // before its batchWithAudit, so a body that is not JSON takes exactly that
    // path and the handler writes nothing. Only the guard can write this row.
    expect(ROUTE_AUDIT["POST /api/contact"]).toBe("enquiry.create");
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request("https://worker.test/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.131" },
        body: "this is not json {",
      }) as never,
      env as never,
      ctx as never
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "Internal error" });
    const rid = res.headers.get("X-Request-Id");
    expect(rid, "the 500 carries no X-Request-Id").toMatch(/.+/);
    const rows = await rowsFor(rid!);
    expect(rows.map((r) => r.action), "exactly one entry, of the declared action").toEqual(["enquiry.create"]);
    expect(rows[0]).toMatchObject({ outcome: "failed", reason: "HTTP 500", phase: "done", via: "api", shop_id: null });
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ method: "POST", route: "/api/contact", status: 500 });
    expect(await gapRowsFor(rid!)).toBe(0);
  });
});
