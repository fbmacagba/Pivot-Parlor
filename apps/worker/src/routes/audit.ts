import { Hono } from "hono";
import type { Context } from "hono";
import { AuditWriteError, userSubjectId, type AuditEntryInput, type Outcome } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { auditFor, auditRefused, systemAudit } from "../audit/context.js";
import { verifyRange } from "../audit/verify.js";

const audit = new Hono<{ Bindings: Bindings }>();
audit.use("*", authMiddleware, requireRole("developer"));

type Ctx = Context<{ Bindings: Bindings }>;
const PAGE = 50;
const EXPORT_MAX = 10_000;

// ─── Ruling 41: shape-validate every list/export filter ────────────────────
// Every value below is used in SQL and echoed into an audit.view / audit.export
// entry's `details` (permanent, hashed) — shape-check before either happens,
// and report only the KEY name back to the caller, never the rejected value.
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_ACTOR = /^[A-Za-z0-9_-]{1,80}$/;
const RE_ACTION = /^[a-z_.]{1,64}$/;
const RE_CURSOR_ID = /^[A-Za-z0-9_-]{1,80}$/;
const OUTCOMES: readonly Outcome[] = ["succeeded", "refused", "failed", "unknown"];
const OUTCOME_SET = new Set<string>(OUTCOMES);

function badDate(s: string): boolean {
  return s.length > 40 || Number.isNaN(Date.parse(s));
}

/** Returns the name of the first invalid filter/cursor key, or null when every
 *  present value has a valid shape. */
function invalidFilterKey(q: Record<string, string>, cursor: string | undefined): string | null {
  if (q.shop_id !== undefined && !RE_ID.test(q.shop_id)) return "shop_id";
  if (q.request_id !== undefined && !RE_ID.test(q.request_id)) return "request_id";
  if (q.actor !== undefined && !RE_ACTOR.test(q.actor)) return "actor";
  if (q.action !== undefined && !RE_ACTION.test(q.action)) return "action";
  if (q.outcome !== undefined && !OUTCOME_SET.has(q.outcome)) return "outcome";
  if (q.from !== undefined && badDate(q.from)) return "from";
  if (q.to !== undefined && badDate(q.to)) return "to";
  if (cursor !== undefined) {
    const parts = cursor.split("|");
    if (parts.length !== 2 || Number.isNaN(Date.parse(parts[0]!)) || !RE_CURSOR_ID.test(parts[1]!)) return "cursor";
  }
  return null;
}

function badRequest(c: Ctx, key: string) {
  return c.json({ success: false, error: `Invalid ${key}` }, 400);
}

interface Filters { where: string; binds: unknown[]; echo: Record<string, string> }

function filters(c: Ctx): Filters {
  const q = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  const echo: Record<string, string> = {};
  const add = (key: string, sql: string, value: unknown) => {
    where.push(sql);
    binds.push(value);
    echo[key] = String(value);
  };
  if (q.shop_id) add("shop_id", "l.shop_id = ?", q.shop_id);
  if (q.actor) add("actor", "l.actor_ref = ?", q.actor.startsWith("subj_") ? q.actor : userSubjectId(q.actor));
  if (q.action) {
    if (q.action.endsWith(".")) {
      // Ruling 41's action regex allows "_" (needed for real actions like
      // "ai.chatbot_model.set"), but "_" is also a LIKE single-character
      // wildcard — escape it so a prefix filter can't match extra actions
      // it didn't ask for. Deviation from the brief's plain `LIKE ?`.
      add("action", "l.action LIKE ? ESCAPE '\\'", `${q.action.replace(/_/g, "\\_")}%`);
    } else {
      add("action", "l.action = ?", q.action);
    }
  }
  if (q.outcome) add("outcome", "l.outcome = ?", q.outcome);
  if (q.from) add("from", "l.occurred_at >= ?", q.from);
  if (q.to) add("to", "l.occurred_at <= ?", q.to);
  if (q.request_id) add("request_id", "l.request_id = ?", q.request_id);
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", binds, echo };
}

const SELECT = `SELECT l.*, a.display_name AS actor_name, a.email AS actor_email, a.redacted_at AS actor_redacted_at, ip.ip AS ip
  FROM audit_log l
  LEFT JOIN audit_subjects a ON a.id = l.actor_ref
  LEFT JOIN audit_subjects ip ON ip.id = l.ip_ref`;

async function guarded<T>(c: Ctx, fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
}

// GET /api/audit — filtered, newest first, cursor = "<occurred_at>|<id>"
audit.get("/", async (c) => {
  const q = c.req.query();
  const cursor = c.req.query("cursor");
  const bad = invalidFilterKey(q, cursor);
  if (bad) return badRequest(c, bad);
  const f = filters(c);
  let where = f.where;
  const binds = [...f.binds];
  if (cursor) {
    const [at, id] = cursor.split("|");
    where = `${where ? `${where} AND` : "WHERE"} (l.occurred_at < ? OR (l.occurred_at = ? AND l.id < ?))`;
    binds.push(at, at, id);
  }
  if (!cursor) {
    const refused = await guarded(c, () => auditFor(c).write({ action: "audit.view", outcome: "succeeded", details: { filters: f.echo } }));
    if (refused instanceof Response) return refused;
  }
  const rows = await c.env.DB.prepare(`${SELECT} ${where} ORDER BY l.occurred_at DESC, l.id DESC LIMIT ?`)
    .bind(...binds, PAGE + 1)
    .all<Record<string, unknown>>();
  const list = rows.results ?? [];
  const page: (Record<string, unknown> & { redacted: boolean })[] = list
    .slice(0, PAGE)
    .map((r) => ({ ...r, redacted: r.actor_redacted_at !== null && r.actor_redacted_at !== undefined }));
  const last = page[page.length - 1];
  return c.json({
    success: true,
    data: { entries: page, next_cursor: list.length > PAGE && last ? `${last.occurred_at}|${last.id}` : null },
  });
});

// POST /api/audit/verify — body { from_seq?, to_seq? }; default = the latest
// 1000 sealed entries. Deliberately does NOT pass { requireArchived: true }:
// this is the manual "Check now" trigger, which should also cover entries
// that are sealed but not yet archived (normal archiving lag) — only the
// 03:00 nightly check (Task 9) treats that lag itself as tampering.
audit.post("/verify", async (c) => {
  const raw = await c.req.json<{ from_seq?: number; to_seq?: number } | null>().catch(() => null);
  const body = raw ?? {};
  const max = (await c.env.DB.prepare("SELECT MAX(seq) AS m FROM audit_log").first<{ m: number | null }>())?.m ?? 0;
  const floor = ((await c.env.DB.prepare("SELECT expired_through_seq AS e FROM audit_seal_state WHERE id = 1").first<{ e: number }>())?.e ?? 0) + 1;
  const to = Math.min(Number.isInteger(body.to_seq) ? body.to_seq! : max, max);
  const from = Math.max(Number.isInteger(body.from_seq) ? body.from_seq! : to - 999, floor);
  // An empty/backwards effective range (e.g. a fresh DB with nothing sealed
  // yet) still gets its own audit.verify entry — skipping the write here
  // would leave this POST with no audit entry of its own, and the gap guard
  // would then log a false audit.gap for exactly the request Rulings 8/42
  // exist to keep truthful. Deviation from the brief, which returned early.
  const result =
    to < from
      ? { ok: true, fromSeq: from, toSeq: to, checked: 0, firstBadSeq: null, problem: null }
      : await verifyRange(c.env.DB, c.env.AUDIT_ARCHIVE, from, to);
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "audit.verify", outcome: result.ok ? "succeeded" : "failed", reason: result.problem, details: { ...result } })
  );
  if (refused instanceof Response) return refused;
  return c.json({ success: true, data: result });
});

const CSV_HEADER = "occurred_at,seq,action,outcome,actor,actor_email,shop_id,entity_type,entity_id,changes,details,request_id,sealed,archived";
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/audit/export?...&part=csv|proof
audit.get("/export", async (c) => {
  const q = c.req.query();
  const bad = invalidFilterKey(q, undefined);
  if (bad) return badRequest(c, bad);
  const f = filters(c);
  const part = c.req.query("part") === "proof" ? "proof" : "csv";
  const refused = await guarded(c, () => auditFor(c).write({ action: "audit.export", outcome: "succeeded", details: { part, filters: f.echo } }));
  if (refused instanceof Response) return refused;
  const rows = (
    await c.env.DB.prepare(`${SELECT} ${f.where} ORDER BY l.occurred_at, l.id LIMIT ?`).bind(...f.binds, EXPORT_MAX).all<Record<string, unknown>>()
  ).results ?? [];
  if (part === "csv") {
    const lines = rows.map((r) =>
      [r.occurred_at, r.seq, r.action, r.outcome, r.actor_name ?? r.actor_type, r.actor_email, r.shop_id, r.entity_type, r.entity_id,
        r.changes_json, r.details_json, r.request_id, r.sealed_at ? "yes" : "no", r.archived_at ? "yes" : "no"].map(csvCell).join(",")
    );
    return new Response([CSV_HEADER, ...lines].join("\n") + "\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="audit-export.csv"' },
    });
  }
  const sealed = rows.filter((r) => typeof r.seq === "number").sort((a, b) => (a.seq as number) - (b.seq as number));
  const first = sealed[0] ?? null;
  const last = sealed[sealed.length - 1] ?? null;
  const archives = [...new Set(sealed.map((r) => r.archive_key).filter(Boolean))];
  const day = (r: Record<string, unknown> | null) => (r ? String(r.sealed_at).slice(0, 10) : null);
  return c.json({
    success: true,
    data: {
      generated_at: new Date().toISOString(),
      filters: f.echo,
      entries: rows.length,
      first: first && { seq: first.seq, chain_hash: first.chain_hash },
      last: last && { seq: last.seq, chain_hash: last.chain_hash },
      archive_objects: archives,
      anchors: [day(first), day(last)].filter(Boolean).map((d) => `anchors/${d}.json`),
      how_to_verify:
        "Recompute each entry's SHA-256 over its canonical fields, chain from the value before 'first', and compare with the archive objects and the emailed daily anchors.",
    },
  });
});

// GET /api/audit/subjects/:subjectId/export — subject access export. Works
// for any existing subject id/kind ('user', 'visitor_ip', 'shop'); entries
// are matched by actor_ref/ip_ref, so a 'shop' subject (referenced only from
// inside details_json.shop_subject, per Task 6) legitimately returns zero
// entries alongside its subject row — see the report for why that is not
// widened here.
audit.get("/subjects/:subjectId/export", async (c) => {
  const subjectId = c.req.param("subjectId");
  const subject = await c.env.DB.prepare("SELECT * FROM audit_subjects WHERE id = ?").bind(subjectId).first();
  if (!subject) return c.json({ success: false, error: "Subject not found" }, 404);
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "data.export", outcome: "succeeded", entityType: "audit_subject", entityId: subjectId })
  );
  if (refused instanceof Response) return refused;
  const entries = (
    await c.env.DB.prepare("SELECT * FROM audit_log WHERE actor_ref = ? OR ip_ref = ? ORDER BY occurred_at LIMIT ?")
      .bind(subjectId, subjectId, EXPORT_MAX)
      .all()
  ).results ?? [];
  return c.json({ success: true, data: { subject, entries } });
});

// POST /api/audit/subjects/:userId/erase — record an erasure request. Per
// Ruling 16/42, redact_after may only ever be brought FORWARD: a later call
// can shorten an already-scheduled wait but never lengthen a date already
// shown to the subject, and a subject that is already redacted is left
// alone. Commits through auditFor(c).batch(...) (Ruling 42/8) rather than
// statements() + db.batch, so a commit failure never falsely marks the
// audit write as having happened.
audit.post("/subjects/:userId/erase", async (c) => {
  const subjectId = userSubjectId(c.req.param("userId"));
  const current = await c.env.DB.prepare("SELECT redact_after, redacted_at FROM audit_subjects WHERE id = ?")
    .bind(subjectId)
    .first<{ redact_after: string | null; redacted_at: string | null }>();
  if (!current) return c.json({ success: false, error: "Subject not found" }, 404);

  const candidate = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const advances = current.redacted_at === null && (current.redact_after === null || current.redact_after > candidate);

  if (!advances) {
    const existing = current.redact_after ?? candidate;
    const refused = await guarded(c, () =>
      auditFor(c).write({
        action: "subject.erase_request",
        outcome: "succeeded",
        entityType: "audit_subject",
        entityId: subjectId,
        details: { redact_after: existing, note: "kept an existing, earlier-or-equal redact_after" },
      })
    );
    if (refused instanceof Response) return refused;
    return c.json({ success: true, data: { redact_after: existing } });
  }

  const update = c.env.DB.prepare(
    "UPDATE audit_subjects SET redact_after = ? WHERE id = ? AND redacted_at IS NULL AND (redact_after IS NULL OR redact_after > ?)"
  ).bind(candidate, subjectId, candidate);
  const input: AuditEntryInput = {
    action: "subject.erase_request",
    outcome: "succeeded",
    entityType: "audit_subject",
    entityId: subjectId,
    changes: { redact_after: [current.redact_after, candidate] },
  };
  const refused = await guarded(c, () => auditFor(c).batch([update], input));
  if (refused instanceof Response) return refused;
  return c.json({ success: true, data: { redact_after: candidate } });
});

// POST /api/audit/import-historical — one-off, idempotent: ai_usage_log
// predates the audit trail, so this backfills each row once as a historical
// ai.call entry attributed to the system (not the developer who happens to
// trigger the backfill), keyed 'hist_<id>' so a re-run never re-imports.
audit.post("/import-historical", async (c) => {
  const rows = (
    await c.env.DB.prepare(
      `SELECT u.* FROM ai_usage_log u WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.id = 'hist_' || u.id) ORDER BY u.created_at LIMIT 500`
    ).all<Record<string, unknown>>()
  ).results ?? [];
  const system = systemAudit(c.env.DB, "api", c.get("requestId") ?? null);
  for (const r of rows) {
    const created = String(r.created_at);
    const iso = created.includes("T") ? new Date(created).toISOString() : new Date(`${created.replace(" ", "T")}Z`).toISOString();
    await system.write({
      id: `hist_${r.id}`,
      occurredAt: iso,
      historical: true,
      action: "ai.call",
      outcome: "succeeded",
      shopId: (r.shop_id as string) ?? null,
      details: {
        worker: r.worker_name, model: r.model, usage_type: r.usage_type, input_tokens: r.input_tokens,
        output_tokens: r.output_tokens, estimated_cost_usd: r.estimated_cost_usd, job_id: r.job_id ?? null,
        note: "historical, not recorded at the time",
      },
    });
  }
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "audit.import.historical", outcome: "succeeded", details: { imported: rows.length } })
  );
  if (refused instanceof Response) return refused;
  return c.json({ success: true, data: { imported: rows.length, more: rows.length === 500 } });
});

export default audit;
