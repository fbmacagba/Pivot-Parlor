import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

describe("audit gap guard", () => {
  it("records an audit.gap entry for an un-instrumented mutating request", async () => {
    const res = await dispatch("POST", "/api/contact", {
      headers: { "CF-Connecting-IP": "192.0.2.10" },
      body: { full_name: "Gap Test", shop_name: "Gap", shop_type: "barber_shop", email: "gap@test.local", message: "hi" },
    });
    const row = await env.DB.prepare(
      "SELECT action, outcome, details_json, actor_type, ip_ref FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ action: string; outcome: string; details_json: string; actor_type: string; ip_ref: string | null }>();
    expect(row, `no gap entry; contact returned ${res.status}`).not.toBeNull();
    expect(JSON.parse(row!.details_json)).toMatchObject({ method: "POST", path: "/api/contact", status: res.status });
    expect(row!.actor_type).toBe("anonymous");
    expect(row!.ip_ref).not.toBeNull();
  });

  it("skips GET requests and unmatched paths", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap'").first<{ n: number }>();
    await dispatch("GET", "/health");
    await dispatch("POST", "/definitely/not/a/route");
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap'").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("gives every request an id", async () => {
    const res = await dispatch("GET", "/health");
    expect(res.headers.get("X-Request-Id")).toMatch(/.+/);
  });

  it("ignores a client-supplied X-Request-Id and records the server id on the audit entry", async () => {
    const res = await dispatch("POST", "/api/contact", {
      headers: { "CF-Connecting-IP": "192.0.2.11", "X-Request-Id": "attacker-chosen" },
      body: { full_name: "RID Test", shop_name: "RID", shop_type: "barber_shop", email: "rid@test.local", message: "hi" },
    });
    const serverId = res.headers.get("X-Request-Id");
    expect(serverId).toMatch(/.+/);
    expect(serverId).not.toBe("attacker-chosen");
    const row = await env.DB.prepare(
      "SELECT request_id FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ request_id: string | null }>();
    expect(row!.request_id).toBe(serverId);
    expect(row!.request_id).not.toBe("attacker-chosen");
  });

  it("writes no audit.gap for a 429 rate-limited response", async () => {
    const ip = "192.0.2.20";
    const body = { full_name: "RL Test", shop_name: "RL", shop_type: "barber_shop", email: "rl@test.local", message: "hi" };
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await dispatch("POST", "/api/contact", { headers: { "CF-Connecting-IP": ip }, body });
    }
    expect(last!.status, "expected the 6th request to be rate-limited").toBe(429);
    const row = await env.DB.prepare(
      "SELECT details_json FROM audit_log WHERE action = 'audit.gap' ORDER BY occurred_at DESC LIMIT 1"
    ).first<{ details_json: string }>();
    expect(JSON.parse(row!.details_json).status, "the most recent audit.gap entry must not be the 429").not.toBe(429);
  });
});
