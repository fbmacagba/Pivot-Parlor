import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { runSealer } from "../src/audit/sealer";

const E = env as unknown as { DB: D1Database; AUDIT_ARCHIVE: R2Bucket };

async function dev() {
  const id = await seedUser("developer", null);
  return { id, token: await tokenFor(id, "developer", null) };
}

/** Every request gets a fresh, server-generated X-Request-Id (audit/request-id.ts).
 *  Scoping assertions by it — instead of a global COUNT(*) — keeps a test
 *  discriminating even though audit_log is shared across the whole file. */
function requestIdOf(res: Response): string {
  const id = res.headers.get("X-Request-Id");
  expect(id).toBeTruthy();
  return id!;
}

async function auditEntriesFor(requestId: string, action: string) {
  return (
    await E.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? AND action = ?")
      .bind(requestId, action)
      .all<Record<string, unknown>>()
  ).results ?? [];
}

describe("/api/audit", () => {
  it("lists entries with actor details and logs the view", async () => {
    const { id, token } = await dev();
    const shopId = await seedShop("Api Shop");
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    const res = await dispatch("GET", `/api/audit?shop_id=${shopId}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: { action: string; actor_email: string }[] } };
    expect(body.data.entries[0]).toMatchObject({ action: "site.pause", actor_email: `${id}@test.local` });
    const view = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.view'").first<{ n: number }>();
    expect(view!.n).toBeGreaterThan(0);
    // Positive control for the two rejection tests below: THIS request's own
    // audit.view exists, scoped by its own request id.
    const [entry] = await auditEntriesFor(requestIdOf(res), "audit.view");
    expect(entry).toBeTruthy();
  });

  it("is developer-only", async () => {
    const shopId = await seedShop("Admin Shop");
    const adminId = await seedUser("admin", shopId);
    const res = await dispatch("GET", "/api/audit", { headers: authHeaders(await tokenFor(adminId, "admin", shopId)) });
    expect(res.status).toBe(403);
  });

  it("rejects a malformed filter with 400 and writes no audit.view entry", async () => {
    const { token } = await dev();
    // shop_id shape is /^[A-Za-z0-9_-]{1,64}$/ — a space and a bang are both illegal.
    const res = await dispatch("GET", "/api/audit?shop_id=not a valid id!", { headers: authHeaders(token) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    // The rejected value itself must never be echoed back.
    expect(body.error).not.toContain("not a valid id!");
    const written = await auditEntriesFor(requestIdOf(res), "audit.view");
    expect(written).toEqual([]);
  });

  it("rejects a malformed cursor with 400 and writes no audit.view entry", async () => {
    const { token } = await dev();
    const res = await dispatch("GET", "/api/audit?cursor=not-a-real-cursor", { headers: authHeaders(token) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cursor/i);
    const written = await auditEntriesFor(requestIdOf(res), "audit.view");
    expect(written).toEqual([]);
  });

  it("verifies a range", async () => {
    const { token } = await dev();
    await runSealer(E);
    const res = await dispatch("POST", "/api/audit/verify", { headers: authHeaders(token), body: {} });
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  it("exports CSV with a header row and a proof file", async () => {
    const { token } = await dev();
    const csv = await dispatch("GET", "/api/audit/export?part=csv", { headers: authHeaders(token) });
    expect(csv.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect((await csv.text()).split("\n")[0]).toBe("occurred_at,seq,action,outcome,actor,actor_email,shop_id,entity_type,entity_id,changes,details,request_id,sealed,archived");
    const proof = await dispatch("GET", "/api/audit/export?part=proof", { headers: authHeaders(token) });
    expect(await proof.json()).toHaveProperty("data.first");
  });

  it("filters by an action prefix without over-matching (LIKE escaping)", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Prefix Shop");
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    const res = await dispatch("GET", "/api/audit?action=site.", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: { action: string }[] } };
    expect(body.data.entries.length).toBeGreaterThan(0);
    for (const e of body.data.entries) expect(e.action.startsWith("site.")).toBe(true);
  });

  it("canonicalizes from/to to ISO instead of echoing raw free text into the permanent entry", async () => {
    const { token } = await dev();
    // Date.parse (and so badDate()'s shape check) is lenient enough to accept
    // this, but the RAW string must never reach details_json (permanent,
    // hashed, never blanked) — that would be a personal-data leak through a
    // filter value.
    const from = encodeURIComponent("2020-01-01 (Jane Smith)");
    const res = await dispatch("GET", `/api/audit?from=${from}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const [entry] = await auditEntriesFor(requestIdOf(res), "audit.view");
    expect(entry).toBeTruthy();
    expect(String(entry!.details_json)).not.toContain("Jane");
    expect(String(entry!.details_json)).toContain("2020-01-01T00:00:00.000Z");
  });

  it("rejects a malformed export filter with 400", async () => {
    const { token } = await dev();
    // outcome must be one of the recorder's real enum values.
    const res = await dispatch("GET", "/api/audit/export?outcome=maybe", { headers: authHeaders(token) });
    expect(res.status).toBe(400);
  });

  it("records an erasure request 30 days out", async () => {
    const { token } = await dev();
    const target = await seedUser("customer", null);
    await E.DB.prepare("INSERT INTO audit_subjects (id, kind, user_id, created_at) VALUES (?, 'user', ?, ?)").bind(`subj_user_${target}`, target, new Date().toISOString()).run();
    const res = await dispatch("POST", `/api/audit/subjects/${target}/erase`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const s = await E.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?").bind(`subj_user_${target}`).first<{ redact_after: string }>();
    expect(Date.parse(s!.redact_after)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    const [entry] = await auditEntriesFor(requestIdOf(res), "subject.erase_request");
    expect(entry!.changes_json).not.toBeNull();
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ redact_after: [null, s!.redact_after] });
  });

  it("keeps an already-redacted subject's date unchanged (Ruling 42)", async () => {
    const { token } = await dev();
    const target = await seedUser("customer", null);
    const fixedDate = "2020-01-01T00:00:00.000Z";
    await E.DB.prepare(
      "INSERT INTO audit_subjects (id, kind, user_id, created_at, redact_after, redacted_at) VALUES (?, 'user', ?, ?, ?, ?)"
    ).bind(`subj_user_${target}`, target, new Date().toISOString(), fixedDate, new Date().toISOString()).run();
    const res = await dispatch("POST", `/api/audit/subjects/${target}/erase`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { redact_after: string } }).data.redact_after).toBe(fixedDate);
    const s = await E.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?").bind(`subj_user_${target}`).first<{ redact_after: string }>();
    expect(s!.redact_after).toBe(fixedDate);
    const [entry] = await auditEntriesFor(requestIdOf(res), "subject.erase_request");
    expect(entry!.changes_json).toBeNull();
  });

  it("keeps an earlier existing redact_after unchanged (Ruling 42)", async () => {
    const { token } = await dev();
    const target = await seedUser("customer", null);
    const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    await E.DB.prepare(
      "INSERT INTO audit_subjects (id, kind, user_id, created_at, redact_after) VALUES (?, 'user', ?, ?, ?)"
    ).bind(`subj_user_${target}`, target, new Date().toISOString(), soon).run();
    const res = await dispatch("POST", `/api/audit/subjects/${target}/erase`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { redact_after: string } }).data.redact_after).toBe(soon);
    const s = await E.DB.prepare("SELECT redact_after FROM audit_subjects WHERE id = ?").bind(`subj_user_${target}`).first<{ redact_after: string }>();
    expect(s!.redact_after).toBe(soon);
    const [entry] = await auditEntriesFor(requestIdOf(res), "subject.erase_request");
    expect(entry!.changes_json).toBeNull();
  });

  it("exports a shop subject's data alongside its (possibly empty) entries", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Subject Shop");
    const subjectId = `subj_shop_${shopId}`;
    await E.DB.prepare("INSERT INTO audit_subjects (id, kind, shop_id, display_name, created_at) VALUES (?, 'shop', ?, ?, ?)")
      .bind(subjectId, shopId, "Subject Shop (subject-shop)", new Date().toISOString())
      .run();
    const res = await dispatch("GET", `/api/audit/subjects/${subjectId}/export`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subject: { kind: string }; entries: unknown[] } };
    expect(body.data.subject.kind).toBe("shop");
    expect(Array.isArray(body.data.entries)).toBe(true);
  });

  it("imports ai_usage_log once, as historical ai.call entries", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Hist Shop");
    await E.DB.prepare(
      "INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at) VALUES ('u-1', ?, 'pivot-parlor-chatbot', 'm', 'chatbot', 10, 5, 15, 0.001, '2026-03-24 21:40:44')"
    ).bind(shopId).run();
    await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
    await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
    const rows = await E.DB.prepare("SELECT historical, occurred_at FROM audit_log WHERE id = 'hist_u-1'").all();
    expect(rows.results).toEqual([{ historical: 1, occurred_at: "2026-03-24T21:40:44.000Z" }]);
  });
});
