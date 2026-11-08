import { describe, expect, it } from "vitest";
import { isAuditAction } from "@repo/audit";
import { app } from "../src/index";
import { CRON_AUDIT, PENDING_CEILING, ROUTE_AUDIT, type AuditDeclaration } from "../src/audit/registry";
import wranglerToml from "../wrangler.toml?raw";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);

// Hono records every `.use("*", ...)` registration in `.routes` as method
// "ALL" too, composed with its mount prefix (e.g. "/booking/shops/:shopId/*").
// Scoped to "ALL" only, so it never touches a POST/PUT/PATCH/DELETE route.
function isWildcardMiddleware(method: string, path: string): boolean {
  return method === "ALL" && (path === "*" || path.endsWith("/*"));
}

function mutatingRoutes(): string[] {
  return [
    ...new Set(
      app.routes
        .filter((r) => MUTATING.has(r.method) && !isWildcardMiddleware(r.method, r.path))
        .map((r) => `${r.method} ${r.path}`)
    ),
  ].sort();
}

function tomlList(re: RegExp): string[] {
  return [...new Set([...wranglerToml.matchAll(re)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)))];
}

const crons = tomlList(/crons\s*=\s*\[([^\]]*)\]/g);
// The booking worker declares queue PRODUCERS only; the reminder consumer
// lives in the API worker, so there is no consumer to register here.
const queueConsumers = [...wranglerToml.matchAll(/queues\.consumers\]\]\s*\nqueue\s*=\s*("[^"]+")/g)].map((m) => m[1]!);

function valid(d: AuditDeclaration): boolean {
  return d === "pending" || (typeof d === "object" && typeof d.exempt === "string" && d.exempt.length > 10) || isAuditAction(d);
}

describe("audit coverage (booking worker)", () => {
  it("every mutating route declares its audit action", () => {
    expect(mutatingRoutes().filter((k) => !(k in ROUTE_AUDIT))).toEqual([]);
  });

  it("the route registry has no stale entries", () => {
    const live = new Set(mutatingRoutes());
    expect(Object.keys(ROUTE_AUDIT).filter((k) => !live.has(k))).toEqual([]);
  });

  it("every cron schedule is declared, and the worker has no queue consumers", () => {
    expect(crons.length).toBeGreaterThan(0);
    expect(crons.filter((c) => !(c in CRON_AUDIT))).toEqual([]);
    expect(queueConsumers).toEqual([]);
  });

  it("every declared cron key exists in wrangler.toml (no stale registry entries)", () => {
    expect(Object.keys(CRON_AUDIT).filter((c) => !crons.includes(c))).toEqual([]);
  });

  it("every declaration is a catalogue action, pending, or a reasoned exemption", () => {
    const bad = Object.entries({ ...ROUTE_AUDIT, ...CRON_AUDIT }).filter(([, d]) => !valid(d));
    expect(bad).toEqual([]);
  });

  it("the pending count matches the ratchet", () => {
    const pending = [...Object.values(ROUTE_AUDIT), ...Object.values(CRON_AUDIT)].filter((d) => d === "pending").length;
    expect(pending, "Lower PENDING_CEILING in src/audit/registry.ts when you instrument something; never raise it").toBe(
      PENDING_CEILING
    );
  });
});
