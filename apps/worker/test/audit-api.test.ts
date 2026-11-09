import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { runSealer } from "../src/audit/sealer";
import { AUDIT_REFUSED_MESSAGE } from "../src/audit/context";
import { EXPORT_LIMITS } from "../src/routes/audit";

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

/** Bypasses the recorder (which validates every action against the fixed
 *  catalogue) to seed a minimal, raw audit_log row — the same technique
 *  test/audit-triggers.test.ts already uses — for tests that only care about
 *  SQL filtering behavior, not the write path itself. */
async function rawAuditRow(action: string): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical)
     VALUES (?, ?, 'x', 'system', 'api', ?, 'done', 'succeeded', 'test', 0)`
  )
    .bind(crypto.randomUUID(), new Date().toISOString(), action)
    .run();
}

const RESEARCH = "pivot-parlor-research";
const TEXT = "pivot-parlor-text";
const CHATBOT = "pivot-parlor-chatbot";

/** A raw audit_log row as a worker's own recorder leaves it: live (historical
 *  0) by default, with the given worker and request id. */
async function workerEntry(
  worker: string,
  requestId: string,
  opts: { phase?: "started" | "outcome"; action?: string; historical?: 0 | 1 } = {}
): Promise<void> {
  const phase = opts.phase ?? "started";
  await E.DB.prepare(
    `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical, request_id)
     VALUES (?, ?, 'x', 'system', 'queue', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(), new Date().toISOString(), opts.action ?? "ai.call", phase,
      phase === "outcome" ? "succeeded" : null, worker, opts.historical ?? 0, requestId
    )
    .run();
}

/** One ai_usage_log row, as @repo/llm's recordAiUsage writes it. */
async function usageRow(worker: string, jobId: string | null): Promise<string> {
  const id = `u-${crypto.randomUUID()}`;
  await E.DB.prepare(
    "INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, job_id, created_at) VALUES (?, NULL, ?, 'm', 'site_research', 1, 1, 2, 0.001, ?, '2026-06-01 00:00:00')"
  ).bind(id, worker, jobId).run();
  return id;
}

async function wasImported(usageId: string): Promise<boolean> {
  return (await E.DB.prepare("SELECT id FROM audit_log WHERE id = ?").bind(`hist_${usageId}`).first()) !== null;
}

async function importHistorical(): Promise<void> {
  const { token } = await dev();
  const res = await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
  expect(res.status).toBe(200);
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

  it("treats empty filter values as absent, not invalid, in both validation and filters() (minor)", async () => {
    const { token } = await dev();
    const res = await dispatch("GET", "/api/audit?shop_id=&action=&outcome=&from=&to=&cursor=", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    // Not just "didn't 400": no empty value reached filters() or its echo,
    // and an empty cursor did not mark the view "paged".
    const [entry] = await auditEntriesFor(requestIdOf(res), "audit.view");
    expect(entry).toBeTruthy();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ filters: {} });
  });

  it("writes its own audit.view for a fabricated (but well-shaped) cursor, marked paged (Ruling 43)", async () => {
    const { token } = await dev();
    // Well-shaped per Ruling 41 (splits into "<iso>|<id>") but references
    // nothing real — this must not read a page of personal data unlogged.
    const cursor = `${new Date().toISOString()}|${crypto.randomUUID()}`;
    const res = await dispatch("GET", `/api/audit?cursor=${encodeURIComponent(cursor)}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const [entry] = await auditEntriesFor(requestIdOf(res), "audit.view");
    expect(entry).toBeTruthy();
    expect(JSON.parse(entry!.details_json as string)).toMatchObject({ paged: true });
  });

  it("refuses (503) a read route when the audit entry cannot be written, and returns no data (minor)", async () => {
    const { token } = await dev();
    await E.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    try {
      const res = await dispatch("GET", "/api/audit", { headers: authHeaders(token) });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    } finally {
      await E.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
  });

  it("verifies a range", async () => {
    const { token } = await dev();
    await runSealer(E);
    const res = await dispatch("POST", "/api/audit/verify", { headers: authHeaders(token), body: {} });
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  it("exports CSV with a header row and a proof file with sealed/unsealed counts and a last_row", async () => {
    const { token } = await dev();
    const csv = await dispatch("GET", "/api/audit/export?part=csv", { headers: authHeaders(token) });
    expect(csv.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect((await csv.text()).split("\n")[0]).toBe("occurred_at,seq,action,outcome,actor,actor_email,shop_id,entity_type,entity_id,changes,details,request_id,sealed,archived");
    const proof = await dispatch("GET", "/api/audit/export?part=proof", { headers: authHeaders(token) });
    const body = (await proof.json()) as {
      data: {
        first: unknown;
        sealed_entries: number;
        unsealed_entries: number;
        last_row: { occurred_at: string; id: string } | null;
        how_to_verify: string;
      };
    };
    expect(body).toHaveProperty("data.first");
    expect(typeof body.data.sealed_entries).toBe("number");
    expect(typeof body.data.unsealed_entries).toBe("number");
    expect(body.data.last_row).toHaveProperty("occurred_at");
    expect(body.data.last_row).toHaveProperty("id");
    expect(body.data.how_to_verify).toMatch(/archive/i);
    expect(body.data.how_to_verify).toMatch(/not from this csv/i);
  });

  it("writes an audit.export entry for a CSV export", async () => {
    const { token } = await dev();
    const res = await dispatch("GET", "/api/audit/export?part=csv", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const [entry] = await auditEntriesFor(requestIdOf(res), "audit.export");
    expect(entry).toBeTruthy();
  });

  it("refuses an export that would silently truncate, for both parts (Ruling 45)", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Overflow Shop");
    // Three entries scoped to this one shop, independent of whatever else the
    // rest of the file has written to the shared audit_log.
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    await dispatch("POST", `/api/shops/${shopId}/activate`, { headers: authHeaders(token) });
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    const originalMax = EXPORT_LIMITS.max;
    EXPORT_LIMITS.max = 2;
    try {
      const csv = await dispatch("GET", `/api/audit/export?shop_id=${shopId}&part=csv`, { headers: authHeaders(token) });
      expect(csv.status).toBe(400);
      expect(((await csv.json()) as { error: string }).error).toBe("Too many entries; narrow the filters");
      const proof = await dispatch("GET", `/api/audit/export?shop_id=${shopId}&part=proof`, { headers: authHeaders(token) });
      expect(proof.status).toBe(400);
      // No audit.export entry for a refused export.
      const written = await auditEntriesFor(requestIdOf(csv), "audit.export");
      expect(written).toEqual([]);
    } finally {
      EXPORT_LIMITS.max = originalMax;
    }
  });

  it("filters by an action prefix without over-matching (LIKE escaping, minor)", async () => {
    const { token } = await dev();
    // Deliberately chosen to contain the "_" that Ruling 41's action regex
    // allows (real actions need it, e.g. "ai.chatbot_model.set") but that is
    // also a LIKE single-character wildcard. "axb.c" differs from "a_b.c"
    // ONLY at that wildcard position, so an unescaped LIKE '%a_b.%' would
    // wrongly match it too.
    await rawAuditRow("a_b.c");
    await rawAuditRow("axb.c");
    const res = await dispatch("GET", `/api/audit?action=${encodeURIComponent("a_b.")}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const actions = ((await res.json()) as { data: { entries: { action: string }[] } }).data.entries.map((e) => e.action);
    expect(actions).toContain("a_b.c");
    expect(actions).not.toContain("axb.c");
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

  it("treats a date-only `to` as the end of that day (minor)", async () => {
    const { token } = await dev();
    const shopId = await seedShop("EndOfDay Shop");
    // occurred_at is "now" — almost certainly after that UTC day's midnight,
    // so a `to` that (wrongly) meant start-of-day would exclude it.
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    const today = new Date().toISOString().slice(0, 10);
    const res = await dispatch("GET", `/api/audit?shop_id=${shopId}&to=${today}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: { action: string }[] } };
    expect(body.data.entries.some((e) => e.action === "site.pause")).toBe(true);
  });

  it("rejects a malformed export filter with 400", async () => {
    const { token } = await dev();
    // outcome must be one of the recorder's real enum values.
    const res = await dispatch("GET", "/api/audit/export?outcome=maybe", { headers: authHeaders(token) });
    expect(res.status).toBe(400);
  });

  it("prefixes a formula-leading CSV cell so it can't execute in a spreadsheet (Ruling 44)", async () => {
    const { id, token } = await dev();
    const injection = '=HYPERLINK("http://evil.com","click")';
    await E.DB.prepare("UPDATE platform_users SET name = ? WHERE id = ?").bind(injection, id).run();
    // Any auditable action by this developer upserts audit_subjects.display_name
    // from platform_users.name at write time (packages/audit/src/recorder.ts).
    await dispatch("GET", "/api/audit", { headers: authHeaders(token) });
    const csv = await dispatch("GET", "/api/audit/export?part=csv", { headers: authHeaders(token) });
    const text = await csv.text();
    // Prefixed with "'" AND quoted (the prefixed string still contains a
    // comma and quotes), matching csvCell()'s own transform — the raw
    // formula text must never appear un-guarded.
    const prefixed = `'${injection}`;
    const expectedCell = `"${prefixed.replace(/"/g, '""')}"`;
    expect(text).toContain(expectedCell);
    expect(text).not.toContain(`,${injection},`);
  });

  it("requires auth (401) and the developer role (403) on export, a subject route and a POST route (minor)", async () => {
    const shopId = await seedShop("RBAC Shop");
    const adminId = await seedUser("admin", shopId);
    const adminToken = await tokenFor(adminId, "admin", shopId);

    const noAuthExport = await dispatch("GET", "/api/audit/export?part=csv");
    expect(noAuthExport.status).toBe(401);

    const noAuthSubject = await dispatch("GET", "/api/audit/subjects/subj_shop_does-not-exist/export");
    expect(noAuthSubject.status).toBe(401);

    const noAuthPost = await dispatch("POST", "/api/audit/verify", { body: {} });
    expect(noAuthPost.status).toBe(401);

    const exportRes = await dispatch("GET", "/api/audit/export?part=csv", { headers: authHeaders(adminToken) });
    expect(exportRes.status).toBe(403);

    const subjectRes = await dispatch("GET", "/api/audit/subjects/subj_shop_does-not-exist/export", { headers: authHeaders(adminToken) });
    expect(subjectRes.status).toBe(403);

    const postRes = await dispatch("POST", "/api/audit/verify", { headers: authHeaders(adminToken), body: {} });
    expect(postRes.status).toBe(403);
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

  it("exports a shop subject's actual entries via shop_id, and logs data.export (Ruling 46)", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Subject Shop");
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    const subjectId = `subj_shop_${shopId}`;
    // shops.ts's own delete/pause flow upserts this row; insert it directly
    // here since this test only pauses (no delete).
    await E.DB.prepare(
      "INSERT INTO audit_subjects (id, kind, shop_id, display_name, created_at) VALUES (?, 'shop', ?, ?, ?) ON CONFLICT(id) DO NOTHING"
    )
      .bind(subjectId, shopId, "Subject Shop (subject-shop)", new Date().toISOString())
      .run();
    const res = await dispatch("GET", `/api/audit/subjects/${subjectId}/export`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subject: { kind: string }; entries: { action: string; shop_id: string }[] } };
    expect(body.data.subject.kind).toBe("shop");
    expect(body.data.entries.some((e) => e.action === "site.pause" && e.shop_id === shopId)).toBe(true);
    const [dataExportEntry] = await auditEntriesFor(requestIdOf(res), "data.export");
    expect(dataExportEntry).toBeTruthy();
  });

  it("refuses an over-limit subject export before writing data.export (Ruling 48)", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Subject Overflow Shop");
    // Three entries scoped to this one shop's subject id, independent of
    // whatever else the rest of the file has written.
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    await dispatch("POST", `/api/shops/${shopId}/activate`, { headers: authHeaders(token) });
    await dispatch("POST", `/api/shops/${shopId}/pause`, { headers: authHeaders(token) });
    const subjectId = `subj_shop_${shopId}`;
    await E.DB.prepare(
      "INSERT INTO audit_subjects (id, kind, shop_id, created_at) VALUES (?, 'shop', ?, ?) ON CONFLICT(id) DO NOTHING"
    ).bind(subjectId, shopId, new Date().toISOString()).run();
    const originalMax = EXPORT_LIMITS.max;
    EXPORT_LIMITS.max = 2;
    try {
      const res = await dispatch("GET", `/api/audit/subjects/${subjectId}/export`, { headers: authHeaders(token) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Too many entries; narrow the dates");
      const written = await auditEntriesFor(requestIdOf(res), "data.export");
      expect(written).toEqual([]);
    } finally {
      EXPORT_LIMITS.max = originalMax;
    }
  });

  it("filters a subject export by from/to, echoing the canonicalized range in details (Ruling 48)", async () => {
    const { token } = await dev();
    const target = await seedUser("customer", null);
    const subjectId = `subj_user_${target}`;
    await E.DB.prepare("INSERT INTO audit_subjects (id, kind, user_id, created_at) VALUES (?, 'user', ?, ?)")
      .bind(subjectId, target, new Date().toISOString())
      .run();
    const insertAt = (occurredAt: string) =>
      E.DB.prepare(
        `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, actor_ref, via, action, phase, outcome, worker, historical)
         VALUES (?, ?, 'x', 'customer', ?, 'api', 'customer.view', 'done', 'succeeded', 'test', 0)`
      ).bind(crypto.randomUUID(), occurredAt, subjectId).run();
    await insertAt("2020-06-01T00:00:00.000Z"); // outside the range below
    await insertAt("2026-06-01T00:00:00.000Z"); // inside it
    const res = await dispatch(
      "GET",
      `/api/audit/subjects/${subjectId}/export?from=2026-01-01&to=2026-12-31`,
      { headers: authHeaders(token) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entries: { occurred_at: string }[] } };
    const dates = body.data.entries.map((e) => e.occurred_at);
    expect(dates).toContain("2026-06-01T00:00:00.000Z");
    expect(dates).not.toContain("2020-06-01T00:00:00.000Z");
    const [entry] = await auditEntriesFor(requestIdOf(res), "data.export");
    // A date-only `to` bumps to end of day, same as the list filters (Ruling 41 minor).
    expect(JSON.parse(entry!.details_json as string)).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-12-31T23:59:59.999Z",
    });
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

  it("skips a row with an unparsable created_at (counted in details) and rounds cost to 6dp (minor)", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Import Edge Shop");
    await E.DB.prepare(
      "INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at) VALUES ('u-good', ?, 'w', 'm', 'chatbot', 1, 1, 2, 0.0000005006, '2026-04-01 00:00:00')"
    ).bind(shopId).run();
    await E.DB.prepare(
      "INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at) VALUES ('u-bad', ?, 'w', 'm', 'chatbot', 1, 1, 2, 0.001, 'not-a-real-date')"
    ).bind(shopId).run();
    const res = await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
    const body = (await res.json()) as { data: { imported: number; skipped: number } };
    expect(body.data.skipped).toBeGreaterThanOrEqual(1);
    const [summary] = await auditEntriesFor(requestIdOf(res), "audit.import.historical");
    expect(JSON.parse(summary!.details_json as string)).toMatchObject({ skipped: body.data.skipped });
    const goodRow = await E.DB.prepare("SELECT details_json FROM audit_log WHERE id = 'hist_u-good'").first<{ details_json: string }>();
    expect(JSON.parse(goodRow!.details_json).estimated_cost_usd).toBe(0.000001);
    const badRow = await E.DB.prepare("SELECT id FROM audit_log WHERE id = 'hist_u-bad'").first();
    expect(badRow).toBeNull();
  });

  it("refuses (503) and writes no hist_ row when the summary entry cannot be written (Ruling 47)", async () => {
    const { token } = await dev();
    const shopId = await seedShop("Import Refusal Shop");
    await E.DB.prepare(
      "INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, created_at) VALUES ('u-refuse', ?, 'w', 'm', 'chatbot', 1, 1, 2, 0.001, '2026-05-01 00:00:00')"
    ).bind(shopId).run();
    // Renaming the whole audit_log table (the usual refusal-simulation
    // technique elsewhere in this suite) also breaks the route's own
    // candidate-selection SELECT, which reads audit_log too — that would
    // 500 before ever reaching a write. Instead, block ONLY the summary
    // entry's INSERT with a targeted trigger: this is exactly the scenario
    // Ruling 47 is about — under the OLD write-it-last order, every hist_
    // row (action 'ai.call', unaffected by this trigger) would already have
    // committed by the time this specific insert failed.
    await E.DB.prepare(
      "CREATE TRIGGER test_block_import_summary BEFORE INSERT ON audit_log WHEN NEW.action = 'audit.import.historical' BEGIN SELECT RAISE(ABORT, 'test forced refusal'); END"
    ).run();
    try {
      const res = await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    } finally {
      await E.DB.prepare("DROP TRIGGER test_block_import_summary").run();
    }
    const hist = await E.DB.prepare("SELECT id FROM audit_log WHERE id = 'hist_u-refuse'").first();
    expect(hist).toBeNull();
  });

  // Plan 4 final review I1: after Plan 4, research, text and chatbot write BOTH
  // a live ai.call and an ai_usage_log row per call. The import must never
  // turn the second into a false, permanent "historical" duplicate.
  it("does not import a research usage row whose job has a live research ai.call (started only)", async () => {
    const job = `job-${crypto.randomUUID()}`;
    const twin = await usageRow(RESEARCH, job);
    await workerEntry(RESEARCH, job, { phase: "started" });
    const control = await usageRow(RESEARCH, `job-${crypto.randomUUID()}`);
    await importHistorical();
    expect(await wasImported(twin)).toBe(false);
    expect(await wasImported(control)).toBe(true);
  });

  it("does not import a chatbot usage row whose public-chat id has a live chatbot ai.call", async () => {
    const reply = crypto.randomUUID();
    const twin = await usageRow(CHATBOT, `public-chat:${reply}`);
    await workerEntry(CHATBOT, reply, { phase: "outcome" });
    const control = await usageRow(CHATBOT, `public-chat:${crypto.randomUUID()}`);
    await importHistorical();
    expect(await wasImported(twin)).toBe(false);
    expect(await wasImported(control)).toBe(true);
  });

  it("still imports a usage row with no live twin, as before", async () => {
    const job = `job-${crypto.randomUUID()}`;
    const row = await usageRow(RESEARCH, job);
    const noJob = await usageRow(RESEARCH, null);
    // None of these is a live ai.call for this job from this worker.
    await workerEntry(RESEARCH, `job-${crypto.randomUUID()}`);
    await workerEntry(RESEARCH, job, { historical: 1 });
    await workerEntry(RESEARCH, job, { action: "site.regenerate.complete", phase: "outcome" });
    await importHistorical();
    expect(await wasImported(row)).toBe(true);
    expect(await wasImported(noJob)).toBe(true);
  });

  it("partial deploy: a research usage row still imports when only text recorded that job live", async () => {
    // Old research (usage row only), new text (usage row and a live ai.call).
    const job = `job-${crypto.randomUUID()}`;
    const research = await usageRow(RESEARCH, job);
    const text = await usageRow(TEXT, job);
    await workerEntry(TEXT, job, { phase: "started" });
    await workerEntry(TEXT, job, { phase: "outcome" });
    await importHistorical();
    expect(await wasImported(research)).toBe(true);
    expect(await wasImported(text)).toBe(false);
  });
});

describe("/api/audit origin_name (Plan 4 Task 9)", () => {
  async function seedOriginSubject(id: string, name: string, redactedAt: string | null) {
    await E.DB.prepare(
      "INSERT INTO audit_subjects (id, kind, user_id, display_name, created_at, redacted_at) VALUES (?, 'user', ?, ?, ?, ?)"
    ).bind(id, id, name, new Date().toISOString(), redactedAt).run();
  }
  async function pipelineRow(requestId: string, detailsJson: string | null) {
    await E.DB.prepare(
      `INSERT INTO audit_log (id, occurred_at, entry_hash, actor_type, via, action, phase, outcome, worker, historical, request_id, details_json)
       VALUES (?, ?, 'x', 'system', 'queue', 'site.regenerate.complete', 'done', 'succeeded', 'test', 0, ?, ?)`
    ).bind(crypto.randomUUID(), new Date().toISOString(), requestId, detailsJson).run();
  }
  async function listByRequest(token: string, requestId: string) {
    const res = await dispatch("GET", `/api/audit?request_id=${requestId}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { data: { entries: { origin_name: string | null; origin_redacted: boolean }[] } };
    return { text, entries: body.data.entries };
  }

  it("a pipeline entry names who clicked", async () => {
    const { token } = await dev();
    const ref = `subj_user_${crypto.randomUUID()}`;
    await seedOriginSubject(ref, "Sam Example", null);
    const rid = `origin-${crypto.randomUUID()}`;
    await pipelineRow(rid, JSON.stringify({ origin_actor_ref: ref }));
    const { entries } = await listByRequest(token, rid);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ origin_name: "Sam Example", origin_redacted: false });
  });

  it("a redacted origin is never named", async () => {
    const { token } = await dev();
    const ref = `subj_user_${crypto.randomUUID()}`;
    await seedOriginSubject(ref, "Hidden Person", new Date().toISOString());
    const rid = `origin-${crypto.randomUUID()}`;
    await pipelineRow(rid, JSON.stringify({ origin_actor_ref: ref }));
    const { text, entries } = await listByRequest(token, rid);
    expect(entries[0]).toMatchObject({ origin_name: null, origin_redacted: true });
    expect(text).not.toContain("Hidden Person");
  });

  it("an entry with no origin has origin_name null", async () => {
    const { token } = await dev();
    const rid = `origin-${crypto.randomUUID()}`;
    await pipelineRow(rid, JSON.stringify({ other: 1 }));
    const { entries } = await listByRequest(token, rid);
    expect(entries[0]).toMatchObject({ origin_name: null, origin_redacted: false });
  });

  it("an unknown origin ref is neither named nor redacted", async () => {
    const { token } = await dev();
    const rid = `origin-${crypto.randomUUID()}`;
    await pipelineRow(rid, JSON.stringify({ origin_actor_ref: "subj_user_missing" }));
    const { entries } = await listByRequest(token, rid);
    expect(entries[0]).toMatchObject({ origin_name: null, origin_redacted: false });
  });

  it("malformed details_json does not fail the page", async () => {
    const { token } = await dev();
    const rid = `origin-${crypto.randomUUID()}`;
    await pipelineRow(rid, "{not json");
    const { entries } = await listByRequest(token, rid);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ origin_name: null, origin_redacted: false });
  });
});
