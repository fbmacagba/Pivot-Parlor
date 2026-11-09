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
// Mutable so tests can lower it without inserting thousands of rows (Ruling 45).
export const EXPORT_LIMITS = { max: 10_000 };

// ─── Ruling 41: shape-validate every list/export filter ────────────────────
// Every value below is used in SQL and echoed into an audit.view / audit.export
// entry's `details` (permanent, hashed) — shape-check before either happens,
// and report only the KEY name back to the caller, never the rejected value.
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_ACTOR = /^[A-Za-z0-9_-]{1,80}$/;
const RE_ACTION = /^[a-z_.]{1,64}$/;
const RE_CURSOR_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES: readonly Outcome[] = ["succeeded", "refused", "failed", "unknown"];
const OUTCOME_SET = new Set<string>(OUTCOMES);

function badDate(s: string): boolean {
  return s.length > 40 || Number.isNaN(Date.parse(s));
}

// Canonicalization shared by every `from`/`to` filter (the list, the export,
// and — Ruling 48 — the subject export): never bind or echo the raw string
// (badDate() only proves Date.parse-able, which is lenient enough to accept
// free text alongside a date), and bump a date-only `to` to the END of that
// day rather than its UTC midnight start.
const isoFrom = (s: string): string => new Date(s).toISOString();
const isoTo = (s: string): string => (DATE_ONLY.test(s) ? `${s}T23:59:59.999Z` : new Date(s).toISOString());

/** Returns the name of the first invalid filter/cursor key, or null when every
 *  present value has a valid shape. An empty value (e.g. `?shop_id=`) is
 *  treated as absent, not invalid — matching filters()'s own truthy checks,
 *  so a blank field left in a GET form doesn't 400. */
function invalidFilterKey(q: Record<string, string>, cursor: string | undefined): string | null {
  if (q.shop_id && !RE_ID.test(q.shop_id)) return "shop_id";
  if (q.request_id && !RE_ID.test(q.request_id)) return "request_id";
  if (q.actor && !RE_ACTOR.test(q.actor)) return "actor";
  if (q.action && !RE_ACTION.test(q.action)) return "action";
  if (q.outcome && !OUTCOME_SET.has(q.outcome)) return "outcome";
  if (q.from && badDate(q.from)) return "from";
  if (q.to && badDate(q.to)) return "to";
  if (cursor) {
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
  const add = (key: string, sql: string, value: unknown, echoValue: unknown = value) => {
    where.push(sql);
    binds.push(value);
    echo[key] = String(echoValue);
  };
  if (q.shop_id) add("shop_id", "l.shop_id = ?", q.shop_id);
  if (q.actor) add("actor", "l.actor_ref = ?", q.actor.startsWith("subj_") ? q.actor : userSubjectId(q.actor));
  if (q.action) {
    if (q.action.endsWith(".")) {
      // Ruling 41's action regex allows "_" (needed for real actions like
      // "ai.chatbot_model.set"), but "_" is also a LIKE single-character
      // wildcard — escape it so a prefix filter can't match extra actions
      // it didn't ask for. Deviation from the brief's plain `LIKE ?`. Echo
      // the validated prefix itself, not the escaped LIKE pattern.
      add("action", "l.action LIKE ? ESCAPE '\\'", `${q.action.replace(/_/g, "\\_")}%`, q.action);
    } else {
      add("action", "l.action = ?", q.action);
    }
  }
  if (q.outcome) add("outcome", "l.outcome = ?", q.outcome);
  if (q.from) add("from", "l.occurred_at >= ?", isoFrom(q.from));
  if (q.to) add("to", "l.occurred_at <= ?", isoTo(q.to));
  if (q.request_id) add("request_id", "l.request_id = ?", q.request_id);
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", binds, echo };
}

const SELECT = `SELECT l.*, a.display_name AS actor_name, a.email AS actor_email, a.redacted_at AS actor_redacted_at, ip.ip AS ip,
  CASE WHEN o.redacted_at IS NULL THEN COALESCE(o.display_name, o.email) END AS origin_name, o.redacted_at AS origin_redacted_at
  FROM audit_log l
  LEFT JOIN audit_subjects a ON a.id = l.actor_ref
  LEFT JOIN audit_subjects ip ON ip.id = l.ip_ref
  LEFT JOIN audit_subjects o ON o.id = CASE WHEN json_valid(l.details_json) THEN json_extract(l.details_json, '$.origin_actor_ref') END`;

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
  const cursor = q.cursor || undefined;
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
  // Ruling 43: EVERY page writes its own audit.view, not just the first — a
  // syntactically valid but fabricated cursor must not read a page of
  // personal data unlogged. `paged: true` marks a scroll versus page one in
  // the permanent record.
  const details = cursor ? { filters: f.echo, paged: true } : { filters: f.echo };
  const refused = await guarded(c, () => auditFor(c).write({ action: "audit.view", outcome: "succeeded", details }));
  if (refused instanceof Response) return refused;
  const rows = await c.env.DB.prepare(`${SELECT} ${where} ORDER BY l.occurred_at DESC, l.id DESC LIMIT ?`)
    .bind(...binds, PAGE + 1)
    .all<Record<string, unknown>>();
  const list = rows.results ?? [];
  const page: (Record<string, unknown> & { redacted: boolean; origin_redacted: boolean })[] = list
    .slice(0, PAGE)
    .map((r) => ({
      ...r,
      redacted: r.actor_redacted_at !== null && r.actor_redacted_at !== undefined,
      origin_redacted: r.origin_redacted_at !== null && r.origin_redacted_at !== undefined,
    }));
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
  const rawFrom = Math.max(Number.isInteger(body.from_seq) ? body.from_seq! : to - 999, floor);
  // Never verify more than 5000 entries in one manual call, regardless of an
  // explicit from_seq/to_seq spread.
  const from = Math.max(rawFrom, to - 4999);
  // An empty/backwards effective range (e.g. a fresh DB with nothing sealed
  // yet) still gets its own audit.verify entry — skipping the write here
  // would leave this POST with no audit entry of its own, and the gap guard
  // would then log a false audit.gap for exactly the request Rulings 8/42
  // exist to keep truthful. Deviation from the brief, which returned early.
  const result =
    to < from
      ? { ok: true, fromSeq: from, toSeq: to, checked: 0, firstBadSeq: null, problem: null, capped: false, archiveObjects: 0 }
      : await verifyRange(c.env.DB, c.env.AUDIT_ARCHIVE, from, to);
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "audit.verify", outcome: result.ok ? "succeeded" : "failed", reason: result.problem, details: { ...result } })
  );
  if (refused instanceof Response) return refused;
  return c.json({ success: true, data: result });
});

const CSV_HEADER = "occurred_at,seq,action,outcome,actor,actor_email,shop_id,entity_type,entity_id,changes,details,request_id,sealed,archived";
// Ruling 44: a cell starting with one of these can be interpreted as a
// formula by Excel/Sheets when the CSV is opened (CSV injection) — user-set
// names/emails reach this export meant for third parties' spreadsheets.
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (CSV_FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// GET /api/audit/export?...&part=csv|proof
audit.get("/export", async (c) => {
  const q = c.req.query();
  const bad = invalidFilterKey(q, undefined);
  if (bad) return badRequest(c, bad);
  const f = filters(c);
  const part = c.req.query("part") === "proof" ? "proof" : "csv";
  // Ruling 45: fetch one row past the cap so an over-large export is
  // refused rather than silently truncated (same query, both parts). Checked
  // BEFORE writing any audit entry — a refused export did not "succeed".
  const rows = (
    await c.env.DB.prepare(`${SELECT} ${f.where} ORDER BY l.occurred_at, l.id LIMIT ?`)
      .bind(...f.binds, EXPORT_LIMITS.max + 1)
      .all<Record<string, unknown>>()
  ).results ?? [];
  if (rows.length > EXPORT_LIMITS.max) {
    return c.json({ success: false, error: "Too many entries; narrow the filters" }, 400);
  }
  const refused = await guarded(c, () => auditFor(c).write({ action: "audit.export", outcome: "succeeded", details: { part, filters: f.echo } }));
  if (refused instanceof Response) return refused;
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
  // Ruling 45: the last row of the WHOLE result (sealed or not), so a caller
  // can pin this CSV/proof pair to it and detect whether new rows appeared.
  const lastRow = rows[rows.length - 1] ?? null;
  const archives = [...new Set(sealed.map((r) => r.archive_key).filter(Boolean))];
  const day = (r: Record<string, unknown> | null) => (r ? String(r.sealed_at).slice(0, 10) : null);
  return c.json({
    success: true,
    data: {
      generated_at: new Date().toISOString(),
      filters: f.echo,
      entries: rows.length,
      sealed_entries: sealed.length,
      unsealed_entries: rows.length - sealed.length,
      last_row: lastRow && { occurred_at: lastRow.occurred_at, id: lastRow.id },
      first: first && { seq: first.seq, chain_hash: first.chain_hash },
      last: last && { seq: last.seq, chain_hash: last.chain_hash },
      archive_objects: archives,
      anchors: [day(first), day(last)].filter(Boolean).map((d) => `anchors/${d}.json`),
      how_to_verify:
        "Recompute each entry's SHA-256 from its copy in the archive objects listed here (not from this CSV; each archive line is a JSON object naming its archive_format and holding that format's columns), chain from the value before 'first', and compare the resulting chain_hash values against the emailed daily anchors.",
    },
  });
});

// GET /api/audit/subjects/:subjectId/export?from&to — subject access export.
// Works for any existing subject kind ('user', 'visitor_ip', 'shop').
audit.get("/subjects/:subjectId/export", async (c) => {
  const subjectId = c.req.param("subjectId");
  const subject = await c.env.DB.prepare("SELECT * FROM audit_subjects WHERE id = ?")
    .bind(subjectId)
    .first<{ id: string; kind: string; shop_id: string | null }>();
  if (!subject) return c.json({ success: false, error: "Subject not found" }, 404);

  // Ruling 48: optional from/to, validated and canonicalized exactly like
  // Ruling 41's list filters (empty value treated as absent; reuses
  // badDate()/isoFrom()/isoTo() rather than duplicating them).
  const q = c.req.query();
  if (q.from && badDate(q.from)) return badRequest(c, "from");
  if (q.to && badDate(q.to)) return badRequest(c, "to");
  const rangeWhere: string[] = [];
  const rangeBinds: unknown[] = [];
  const echo: Record<string, string> = {};
  if (q.from) {
    const iso = isoFrom(q.from);
    rangeWhere.push("occurred_at >= ?");
    rangeBinds.push(iso);
    echo.from = iso;
  }
  if (q.to) {
    const iso = isoTo(q.to);
    rangeWhere.push("occurred_at <= ?");
    rangeBinds.push(iso);
    echo.to = iso;
  }

  // Ruling 46: pick the WHERE by kind instead of an unindexed OR across two
  // columns. A 'shop' subject is never referenced from actor_ref/ip_ref (Task
  // 6 puts it only inside details_json.shop_subject) — shop_id is its real,
  // indexed key (idx_audit_log_shop_time).
  const [column, value] =
    subject.kind === "shop"
      ? (["shop_id", subject.shop_id ?? subjectId] as const)
      : subject.kind === "visitor_ip"
        ? (["ip_ref", subjectId] as const)
        : (["actor_ref", subjectId] as const);
  const where = [`${column} = ?`, ...rangeWhere].join(" AND ");

  // Ruling 48: fetch one row past the cap and refuse (before writing any
  // audit entry) rather than silently truncate — a shop subject can now
  // span that shop's whole history (Ruling 46), same ordering Ruling 45
  // uses for /export.
  const entries = (
    await c.env.DB.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY occurred_at LIMIT ?`)
      .bind(value, ...rangeBinds, EXPORT_LIMITS.max + 1)
      .all<Record<string, unknown>>()
  ).results ?? [];
  if (entries.length > EXPORT_LIMITS.max) {
    return c.json({ success: false, error: "Too many entries; narrow the dates" }, 400);
  }

  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "data.export", outcome: "succeeded", entityType: "audit_subject", entityId: subjectId, details: echo })
  );
  if (refused instanceof Response) return refused;
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
    // Never fabricate a date: report the subject's real (possibly null)
    // redact_after rather than substituting the just-computed candidate.
    const existing = current.redact_after;
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

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Returns the ISO instant for an ai_usage_log.created_at value, or null if
 *  it can't be parsed at all (rather than throwing new Date(NaN)). */
function historicalIso(createdAt: unknown): string | null {
  const s = String(createdAt);
  const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// POST /api/audit/import-historical — one-off, idempotent: ai_usage_log
// predates the audit trail, so this backfills each row once as a historical
// ai.call entry attributed to the system (not the developer who happens to
// trigger the backfill), keyed 'hist_<id>' so a re-run never re-imports.
//
// A usage row that already has a LIVE twin is never a candidate (Plan 4 final
// review I1): since Plan 4, research, text and chatbot record each call as a
// live ai.call AND an ai_usage_log row, and importing the row would add a
// false, permanent "historical" duplicate. The twin is a live ai.call (any
// phase: a started-only row still counts) from the SAME worker, so a row from
// a worker that never recorded live (a partial deploy) still imports. Its
// request id is the job id for the queue workers (queueAudit), and the
// <uuid> of the chatbot's 'public-chat:<uuid>' job id (Ruling P13). l.request_id
// is compared bare, so idx_audit_log_request serves the lookup. The exclusion
// is in SQL, not a filter after the LIMIT, so `more` stays truthful.
const IMPORT_CANDIDATES_SQL = `SELECT u.* FROM ai_usage_log u
  WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.id = 'hist_' || u.id)
    AND NOT EXISTS (
      SELECT 1 FROM audit_log l
      WHERE l.request_id = CASE WHEN u.job_id LIKE 'public-chat:%' THEN substr(u.job_id, 13) ELSE u.job_id END
        AND l.worker = u.worker_name
        AND l.action = 'ai.call'
        AND l.historical = 0
    )
  ORDER BY u.created_at LIMIT 500`;

audit.post("/import-historical", async (c) => {
  const rows = (await c.env.DB.prepare(IMPORT_CANDIDATES_SQL).all<Record<string, unknown>>()).results ?? [];
  const candidates: { row: Record<string, unknown>; iso: string }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const iso = historicalIso(r.created_at);
    if (iso === null) {
      skipped++;
      continue;
    }
    candidates.push({ row: r, iso });
  }
  // Ruling 47: write the summary entry FIRST and refuse before any hist_ row
  // is written (spec 4.4, entry-before-acting) — the old order wrote every
  // hist_ row unconditionally and only attempted this entry at the end, so a
  // refusal there falsely claimed "nothing was changed" after hundreds of
  // rows already had been.
  const refused = await guarded(c, () =>
    auditFor(c).write({ action: "audit.import.historical", outcome: "succeeded", details: { candidates: rows.length, skipped } })
  );
  if (refused instanceof Response) return refused;
  const system = systemAudit(c.env.DB, "api", c.get("requestId") ?? null);
  for (const { row: r, iso } of candidates) {
    await system.write({
      id: `hist_${r.id}`,
      occurredAt: iso,
      historical: true,
      action: "ai.call",
      outcome: "succeeded",
      shopId: (r.shop_id as string) ?? null,
      details: {
        worker: r.worker_name, model: r.model, usage_type: r.usage_type, input_tokens: r.input_tokens,
        output_tokens: r.output_tokens, estimated_cost_usd: round6(r.estimated_cost_usd as number), job_id: r.job_id ?? null,
        note: "historical, not recorded at the time",
      },
    });
  }
  return c.json({ success: true, data: { imported: candidates.length, skipped, more: rows.length === 500 } });
});

export default audit;
