import { describe, expect, it } from "vitest";
import { isAuditAction } from "@repo/audit";
import { app, stripeWebhookApp } from "../src/index";
import { CRON_AUDIT, PENDING_CEILING, QUEUE_AUDIT, ROUTE_AUDIT, type AuditDeclaration } from "../src/audit/registry";
import wranglerToml from "../wrangler.toml?raw";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function mutatingRoutes(): string[] {
  const all = [...app.routes, ...stripeWebhookApp.routes];
  return [...new Set(all.filter((r) => MUTATING.has(r.method)).map((r) => `${r.method} ${r.path}`))].sort();
}

function tomlList(re: RegExp): string[] {
  return [...new Set([...wranglerToml.matchAll(re)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)))];
}

const crons = tomlList(/crons\s*=\s*\[([^\]]*)\]/g);
const queues = [...new Set([...wranglerToml.matchAll(/queues\.consumers\]\]\s*\nqueue\s*=\s*("[^"]+")/g)].map((m) => JSON.parse(m[1]!) as string))];

function valid(d: AuditDeclaration): boolean {
  return d === "pending" || (typeof d === "object" && typeof d.exempt === "string" && d.exempt.length > 10) || isAuditAction(d);
}

describe("audit coverage", () => {
  it("every mutating route declares its audit action", () => {
    expect(mutatingRoutes().filter((k) => !(k in ROUTE_AUDIT))).toEqual([]);
  });

  it("the route registry has no stale entries", () => {
    const live = new Set(mutatingRoutes());
    expect(Object.keys(ROUTE_AUDIT).filter((k) => !live.has(k))).toEqual([]);
  });

  it("every cron schedule and queue consumer is declared", () => {
    expect(crons.length).toBeGreaterThan(0);
    expect(queues.length).toBeGreaterThan(0);
    expect(crons.filter((c) => !(c in CRON_AUDIT))).toEqual([]);
    expect(queues.filter((q) => !(q in QUEUE_AUDIT))).toEqual([]);
  });

  it("every declaration is a catalogue action, pending, or a reasoned exemption", () => {
    const bad = Object.entries({ ...ROUTE_AUDIT, ...CRON_AUDIT, ...QUEUE_AUDIT }).filter(([, d]) => !valid(d));
    expect(bad).toEqual([]);
  });

  it("the pending count matches the ratchet", () => {
    const pending = [...Object.values(ROUTE_AUDIT), ...Object.values(CRON_AUDIT), ...Object.values(QUEUE_AUDIT)].filter(
      (d) => d === "pending"
    ).length;
    expect(pending, "Lower PENDING_CEILING in src/audit/registry.ts when you instrument something; never raise it").toBe(
      PENDING_CEILING
    );
  });
});
