/**
 * The assembler on real D1 (the main worker's full migration chain): every
 * terminal path is ONE batch holding its writes, the guarded job completion
 * and exactly one `site.regenerate.complete` entry, so a refused entry leaves
 * nothing behind and a redelivered message records nothing twice.
 */
import { env } from "cloudflare:test";
import type { D1Database, D1PreparedStatement, KVNamespace, MessageBatch } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completionEntryId } from "@repo/audit";
import worker, { type Env } from "../src/index";

const ORIGIN = "subj_user_owner-t7";
const JOB_STATUS_SQL = "SELECT status FROM generation_jobs WHERE id = ?";

const textPayload = (over: Record<string, unknown> = {}) => ({
  headline: "Sharp cuts on Example Row",
  tagline: "Walk in, sit down, look sharp.",
  about: "A neighbourhood barber.",
  services: [{ name: "Skin fade", price_gbp: 24, duration_minutes: 40, description: "A clean fade.", image_prompt: "fade" }],
  seo_title: "Test Barber",
  seo_description: "Book a cut.",
  color_primary: "#111111",
  color_accent: "#C9A84C",
  font_heading: "Jost",
  font_body: "DM Sans",
  completedAt: "2026-11-09T00:00:00Z",
  ...over,
});

const imagesPayload = () => ({
  heroUrl: "https://img.test/new-hero.png",
  logoUrl: "",
  catalogUrls: ["https://img.test/fade.png"],
  galleryUrls: [],
  completedAt: "2026-11-09T00:00:00Z",
  errors: [],
});

const researchPayload = (over: Record<string, unknown> = {}) => ({
  spec: { layout_mood: "calm" },
  shopName: "Test Barber",
  template: "minimal",
  ...over,
});

type Payload = unknown | string | null;

interface Setup {
  shopId: string;
  shopSlug: string;
  jobId: string;
  message: { jobId: string; shopId: string; shopSlug: string; origin_actor_ref: string };
}

/** A shop, a running job and its gen:* payloads (an object is JSON-encoded,
 *  a string is stored raw, null is left out). Ids are unique per test:
 *  storage is NOT reset between tests in this file. */
async function setup(
  opts: {
    shopStatus?: string;
    isActive?: number;
    text?: Payload;
    images?: Payload;
    research?: Payload;
  } = {}
): Promise<Setup> {
  const tag = crypto.randomUUID();
  const shopId = `shop-${tag}`;
  const shopSlug = `t7-${tag.slice(0, 8)}`;
  const jobId = `job-${tag}`;
  await env.DB.prepare(
    "INSERT INTO shops (id, shop_number, slug, name, owner_email, status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(shopId, Math.floor(Math.random() * 1_000_000_000), shopSlug, "Test Barber", `${tag}@test.local`, opts.shopStatus ?? "pending", opts.isActive ?? 0)
    .run();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO generation_jobs (id, shop_id, status, stage, created_at, updated_at) VALUES (?, ?, 'running', 'assemble', ?, ?)"
  )
    .bind(jobId, shopId, now, now)
    .run();
  await putPayloads(jobId, {
    text: opts.text === undefined ? textPayload() : opts.text,
    images: opts.images === undefined ? imagesPayload() : opts.images,
    research: opts.research === undefined ? researchPayload() : opts.research,
  });
  return { shopId, shopSlug, jobId, message: { jobId, shopId, shopSlug, origin_actor_ref: ORIGIN } };
}

async function putPayloads(jobId: string, p: { text: Payload; images: Payload; research: Payload }): Promise<void> {
  for (const [stage, value] of Object.entries(p)) {
    if (value === null) continue;
    await env.KV.put(`gen:${jobId}:${stage}`, typeof value === "string" ? value : JSON.stringify(value));
  }
}

/** Another running job for an existing shop, with its gen:* payloads. */
async function addJob(shopId: string, p: { text: Payload; images: Payload; research: Payload }): Promise<string> {
  const jobId = `job-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO generation_jobs (id, shop_id, status, stage, created_at, updated_at) VALUES (?, ?, 'running', 'assemble', ?, ?)"
  )
    .bind(jobId, shopId, now, now)
    .run();
  await putPayloads(jobId, p);
  return jobId;
}

/** A live (or any other website_status) published row, as the API worker leaves it. */
async function seedSite(shopId: string, websiteStatus: string, headline: string): Promise<{ generated_at: string }> {
  const generated_at = "2026-01-01T00:00:00.000Z";
  await env.DB.prepare(
    "INSERT INTO shop_sites (id, shop_id, template, headline, generated_at, status, website_status) VALUES (?, ?, 'classic', ?, ?, 'active', ?)"
  )
    .bind(crypto.randomUUID(), shopId, headline, generated_at, websiteStatus)
    .run();
  return { generated_at };
}

/** Deliver one message through the real queue handler. */
async function deliver(body: unknown, opts: { db?: D1Database; kv?: KVNamespace } = {}) {
  const sent: Array<{ body: unknown; options: unknown }> = [];
  const workerEnv = {
    DB: opts.db ?? env.DB,
    KV: opts.kv ?? env.KV,
    SITE_ASSEMBLE_QUEUE: {
      async send(b: unknown, options?: unknown) {
        sent.push({ body: b, options });
      },
    },
    ENVIRONMENT: "test",
  } as unknown as Env;
  let acked = 0;
  const batch = { messages: [{ body, ack: () => void acked++ }] } as unknown as MessageBatch<unknown>;
  await worker.queue(batch, workerEnv);
  return { sent, acked };
}

/** The SQL a real D1 statement carries (probed: workerd exposes it as `statement`). */
function sqlOf(stmt: D1PreparedStatement): string {
  const sql = (stmt as unknown as { statement?: unknown }).statement;
  if (typeof sql !== "string") throw new Error("this D1 build no longer exposes a statement's SQL; the test hook needs another way");
  return sql;
}

/**
 * The real D1, observed and optionally steered:
 *  - `prepared` is every SQL text the worker prepared, in order;
 *  - `batches` is every batch, its SQL in order and how it settled;
 *  - `failBatchWhen`: a batch holding a matching statement is still sent to
 *    D1, with a statement appended that fails when it EXECUTES, so D1 itself
 *    rolls back everything before it;
 *  - `firstJobStatus`: only the worker's FIRST job-status read answers this
 *    (finishJob's re-read is the identical SQL and must reach the table).
 */
function hookedDb(hooks: { failBatchWhen?: (sql: string) => boolean; firstJobStatus?: string } = {}) {
  const prepared: string[] = [];
  const batches: Array<{ sqls: string[]; settled: "committed" | "rolled_back" }> = [];
  let firstReadFaked = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          prepared.push(sql);
          if (hooks.firstJobStatus && sql === JOB_STATUS_SQL && !firstReadFaked) {
            firstReadFaked = true;
            const answer = { status: hooks.firstJobStatus };
            return { bind: () => ({ first: async () => answer }) };
          }
          return target.prepare(sql);
        };
      }
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const sqls = stmts.map(sqlOf);
          const refuse = hooks.failBatchWhen ? sqls.some(hooks.failBatchWhen) : false;
          // Prepares fine, fails on execution (generation_jobs.shop_id is NOT NULL).
          const poison = target.prepare("INSERT INTO generation_jobs (id, shop_id) VALUES ('t7-poison', NULL)");
          try {
            const out = await target.batch(refuse ? [...stmts, poison] : stmts);
            batches.push({ sqls, settled: "committed" });
            return out;
          } catch (err) {
            batches.push({ sqls, settled: "rolled_back" });
            throw err;
          }
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db, prepared, batches };
}

/** Which terminal batch this was, by the statements it held. */
const kind = (b: { sqls: string[] }): "publish" | "review" | "finish" =>
  b.sqls.some((q) => q.startsWith("INSERT INTO shop_sites"))
    ? "publish"
    : b.sqls.some((q) => q.startsWith("INSERT INTO shop_site_candidates"))
      ? "review"
      : "finish";

interface EntryRow {
  id: string;
  action: string;
  phase: string;
  outcome: string | null;
  reason: string | null;
  shop_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  changes_json: string | null;
  details_json: string | null;
  request_id: string | null;
  worker: string;
  via: string;
  actor_type: string;
}

async function completions(shopId: string): Promise<EntryRow[]> {
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'site.regenerate.complete' AND shop_id = ?")
    .bind(shopId)
    .all<EntryRow>();
  return r.results ?? [];
}

const json = (s: string | null) => (s === null ? null : (JSON.parse(s) as Record<string, unknown>));

async function job(jobId: string) {
  return env.DB.prepare("SELECT status, stage, error FROM generation_jobs WHERE id = ?")
    .bind(jobId)
    .first<{ status: string; stage: string; error: string | null }>();
}

async function shop(shopId: string) {
  return env.DB.prepare("SELECT status, is_active FROM shops WHERE id = ?").bind(shopId).first<{ status: string; is_active: number }>();
}

async function sites(shopId: string) {
  const r = await env.DB.prepare("SELECT * FROM shop_sites WHERE shop_id = ?").bind(shopId).all<Record<string, unknown>>();
  return r.results ?? [];
}

async function candidate(shopId: string) {
  return env.DB.prepare("SELECT job_id, payload_json FROM shop_site_candidates WHERE shop_id = ?")
    .bind(shopId)
    .first<{ job_id: string; payload_json: string }>();
}

const genKeys = (jobId: string) => [
  `gen:${jobId}:research`,
  `gen:${jobId}:images`,
  `gen:${jobId}:text`,
  `gen:${jobId}:assemble:retries`,
  `gen:${jobId}:assemble:text_retries`,
];

async function kvLeft(keys: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const k of keys) if ((await env.KV.get(k)) !== null) left.push(k);
  return left;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publish: one audited batch", () => {
  it("the first publish inserts the site, completes the job, activates the shop and records one entry, together", async () => {
    const s = await setup({
      research: researchPayload({ template: "bold", owner_color_primary: "#123456", owner_color_accent: "#abcdef" }),
    });
    await env.KV.put(`site:${s.shopSlug}`, "cached");
    const h = hookedDb();

    const { acked } = await deliver(s.message, { db: h.db });
    expect(acked).toBe(1);

    const rows = await sites(s.shopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "active",
      template: "bold",
      headline: "Sharp cuts on Example Row",
      hero_image_url: "https://img.test/new-hero.png",
      catalog_images_json: JSON.stringify(["https://img.test/fade.png"]),
      color_primary: "#111111",
      font_heading: "Jost",
      seo_title: "Test Barber",
      layout_mood: "calm",
      design_version: 2,
      owner_color_primary: "#123456",
      owner_color_accent: "#abcdef",
    });
    expect(await job(s.jobId)).toEqual({ status: "complete", stage: "complete", error: null });
    expect(await shop(s.shopId)).toEqual({ status: "active", is_active: 1 });

    const entries = await completions(s.shopId);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e).toMatchObject({
      id: await completionEntryId(s.jobId),
      phase: "done",
      outcome: "succeeded",
      reason: null,
      entity_type: "shop",
      entity_id: s.shopId,
      request_id: s.jobId,
      worker: "pivot-parlor-assembler",
      via: "queue",
      actor_type: "system",
    });
    expect(json(e.changes_json)).toEqual({ status: ["pending", "active"], is_active: [0, 1] });
    expect(json(e.details_json)).toEqual({ job_id: s.jobId, stage: "complete", result: "complete", origin_actor_ref: ORIGIN });

    // Together: ONE batch, in the decided order.
    const committed = h.batches.filter((b) => b.settled === "committed");
    expect(committed).toHaveLength(1);
    // The palette comes after BOTH site statements, or a first publish would lose it.
    expect(committed[0]!.sqls.map((q) => q.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringMatching(/^UPDATE shop_sites SET headline = \?/),
      expect.stringMatching(/^INSERT INTO shop_sites \(.+ WHERE NOT EXISTS \(SELECT 1 FROM shop_sites WHERE shop_id = \?\)$/),
      expect.stringMatching(/^UPDATE shop_sites SET owner_color_primary/),
      expect.stringMatching(/^UPDATE shops SET status = 'active'/),
      expect.stringMatching(/^UPDATE generation_jobs SET status = \?/),
      expect.stringMatching(/^INSERT INTO audit_log /),
    ]);

    // After the batch: the working keys and the public cache are gone.
    expect(await kvLeft(genKeys(s.jobId))).toEqual([]);
    expect(await env.KV.get(`site:${s.shopSlug}`)).toBeNull();
  });

  it("an already active shop records no changes, and no owner palette means no palette write", async () => {
    const s = await setup({ shopStatus: "active", isActive: 1 });
    const h = hookedDb();
    await deliver(s.message, { db: h.db });
    const entries = await completions(s.shopId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.changes_json).toBeNull();
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.sqls.some((q) => q.includes("owner_color_primary"))).toBe(false);
  });

  it("a second publish for the same shop updates the row and keeps its template", async () => {
    const first = await setup({ research: researchPayload({ template: "bold", owner_color_primary: "#123456", owner_color_accent: "#abcdef" }) });
    await deliver(first.message);
    const [before] = await sites(first.shopId);
    // Columns no publish writes must survive the site write.
    await env.DB.prepare("UPDATE shop_sites SET design_notes = 'keep me', locked_images_json = '{\"logo\":true}' WHERE shop_id = ?")
      .bind(first.shopId)
      .run();

    const secondJob = await addJob(first.shopId, {
      text: textPayload({ headline: "Fresh fades on Example Row", color_primary: "#222222" }),
      images: imagesPayload(),
      research: researchPayload({ template: "classic" }),
    });
    await deliver({ ...first.message, jobId: secondJob });

    const rows = await sites(first.shopId);
    expect(rows).toHaveLength(1);
    const after = rows[0]!;
    expect(after.id).toBe(before!.id);
    expect(after.template).toBe("bold");
    expect(after.headline).toBe("Fresh fades on Example Row");
    expect(after.color_primary).toBe("#222222");
    expect(after.status).toBe("active");
    expect(after.generated_at).not.toBe(before!.generated_at);
    expect(after).toMatchObject({
      design_notes: "keep me",
      locked_images_json: '{"logo":true}',
      website_status: "draft",
      owner_color_primary: "#123456",
      owner_color_accent: "#abcdef",
    });
    expect(await job(secondJob)).toEqual({ status: "complete", stage: "complete", error: null });
    const entries = await completions(first.shopId);
    expect(entries.map((e) => json(e.details_json)?.job_id).sort()).toEqual([first.jobId, secondJob].sort());
    // The second publish found the shop already active.
    expect(entries.find((e) => json(e.details_json)?.job_id === secondJob)!.changes_json).toBeNull();
  });

  it("a redelivered message changes nothing and records nothing", async () => {
    const s = await setup();
    await deliver(s.message);
    const [published] = await sites(s.shopId);

    // Fresh payloads with a different headline: only the job-status skip stands
    // between this redelivery and a second publish.
    await putPayloads(s.jobId, { text: textPayload({ headline: "Should never be published" }), images: imagesPayload(), research: researchPayload() });
    const { sent } = await deliver(s.message);

    expect(sent).toEqual([]);
    expect(await completions(s.shopId)).toHaveLength(1);
    const [after] = await sites(s.shopId);
    expect(after!.generated_at).toBe(published!.generated_at);
    expect(after!.headline).toBe("Sharp cuts on Example Row");
    expect(await job(s.jobId)).toEqual({ status: "complete", stage: "complete", error: null });
  });

  it("a duplicate that got past the first read rolls back whole on the entry's primary key", async () => {
    const s = await setup();
    await deliver(s.message);
    const [published] = await sites(s.shopId);
    const shopBefore = await shop(s.shopId);

    await putPayloads(s.jobId, { text: textPayload({ headline: "Should never be published" }), images: imagesPayload(), research: researchPayload() });
    const h = hookedDb({ firstJobStatus: "running" });
    await deliver(s.message, { db: h.db });

    // The duplicate really did send its publish batch, and D1 refused it whole.
    const publish = h.batches.filter((b) => kind(b) === "publish");
    expect(publish).toHaveLength(1);
    expect(publish[0]!.settled).toBe("rolled_back");
    // finishJob read the job back as complete: no crash path, nothing else sent.
    expect(h.batches).toHaveLength(1);

    expect(await completions(s.shopId)).toHaveLength(1);
    const [after] = await sites(s.shopId);
    expect(after!.headline).toBe("Sharp cuts on Example Row");
    expect(after!.generated_at).toBe(published!.generated_at);
    expect(await shop(s.shopId)).toEqual(shopBefore);
    expect(await job(s.jobId)).toEqual({ status: "complete", stage: "complete", error: null });
    expect(await kvLeft(genKeys(s.jobId))).toEqual([]);
  });

  it("a failing entry leaves the live site and the job untouched", async () => {
    const s = await setup();
    const live = await seedSite(s.shopId, "draft", "The published headline");
    await env.KV.put(`site:${s.shopSlug}`, "cached");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = hookedDb({ failBatchWhen: (q) => q.startsWith("INSERT INTO audit_log") });

    await deliver(s.message, { db: h.db });

    // The publish batch and the crash path's failed completion were both refused.
    expect(h.batches.map((b) => [kind(b), b.settled])).toEqual([
      ["publish", "rolled_back"],
      ["finish", "rolled_back"],
    ]);
    // The clean-up runs only AFTER a batch commits: the cache and the working keys survive.
    expect(await env.KV.get(`site:${s.shopSlug}`)).toBe("cached");
    expect(await kvLeft(genKeys(s.jobId))).toEqual([`gen:${s.jobId}:research`, `gen:${s.jobId}:images`, `gen:${s.jobId}:text`]);
    const [row] = await sites(s.shopId);
    expect(row).toMatchObject({ headline: "The published headline", generated_at: live.generated_at, template: "classic" });
    expect(await shop(s.shopId)).toEqual({ status: "pending", is_active: 0 });
    // Ruling 5: the best-effort write still ends the job, never as complete.
    const j = await job(s.jobId);
    expect(j?.status).toBe("failed");
    expect(j?.stage).toBe("assemble");
    expect(await completions(s.shopId)).toHaveLength(0);
    expect(errors.mock.calls.some((c) => c[0] === "[audit] job failed without its completion entry" && c[1] === s.jobId)).toBe(true);
  });
});

describe("review: one audited batch", () => {
  it("the review path stores the candidate, completes the job and records the entry in one batch", async () => {
    const s = await setup({ shopStatus: "active", isActive: 1 });
    const live = await seedSite(s.shopId, "live", "The live headline");
    await env.KV.put(`site:${s.shopSlug}`, "cached");
    const h = hookedDb();

    await deliver(s.message, { db: h.db });

    const c = await candidate(s.shopId);
    expect(c?.job_id).toBe(s.jobId);
    const payload = JSON.parse(c!.payload_json) as { columns: Record<string, unknown> };
    expect(payload.columns.headline).toBe("Sharp cuts on Example Row");

    expect(await job(s.jobId)).toEqual({ status: "complete", stage: "review", error: null });
    const entries = await completions(s.shopId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: await completionEntryId(s.jobId), outcome: "succeeded", reason: null, changes_json: null });
    // Ruling P10: review is told apart by stage; result is the job status.
    const details = json(entries[0]!.details_json)!;
    expect(details.stage).toBe("review");
    expect(details.result).toBe("complete");
    expect(details.origin_actor_ref).toBe(ORIGIN);

    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.settled).toBe("committed");
    expect(h.batches[0]!.sqls.map((q) => q.trimStart().slice(0, 33))).toEqual([
      "INSERT INTO shop_site_candidates ",
      expect.stringMatching(/^UPDATE generation_jobs SET status/),
      expect.stringMatching(/^INSERT INTO audit_log/),
    ]);

    // Nothing public changed.
    const [row] = await sites(s.shopId);
    expect(row).toMatchObject({ headline: "The live headline", generated_at: live.generated_at });
    expect(await env.KV.get(`site:${s.shopSlug}`)).toBe("cached");
    expect(await kvLeft(genKeys(s.jobId))).toEqual([]);
  });

  it("a refused entry on the review path stores no candidate", async () => {
    const s = await setup({ shopStatus: "active", isActive: 1 });
    await seedSite(s.shopId, "paused", "The paused headline");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = hookedDb({ failBatchWhen: (q) => q.startsWith("INSERT INTO audit_log") });

    await deliver(s.message, { db: h.db });

    expect(await candidate(s.shopId)).toBeNull();
    expect((await job(s.jobId))?.status).toBe("failed");
    expect(await completions(s.shopId)).toHaveLength(0);
  });
});

describe("failure exits: one failed completion entry each", () => {
  // Every exit logs its failure; keep those stack traces out of the run.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  async function expectFailed(s: Setup, reason: string, error: string | RegExp) {
    const j = await job(s.jobId);
    expect(j?.status).toBe("failed");
    expect(j?.stage).toBe("assemble");
    if (typeof error === "string") expect(j?.error).toBe(error);
    else expect(j?.error).toMatch(error);
    const entries = await completions(s.shopId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: await completionEntryId(s.jobId), outcome: "failed", reason, changes_json: null });
    expect(json(entries[0]!.details_json)).toEqual({ job_id: s.jobId, stage: "assemble", result: "failed", origin_actor_ref: ORIGIN });
    // Never a published row.
    expect((await sites(s.shopId)).filter((r) => r.headline === "Sharp cuts on Example Row")).toHaveLength(0);
  }

  it("missing text after the retries", async () => {
    const s = await setup({ text: null });
    await env.KV.put(`gen:${s.jobId}:assemble:text_retries`, "20");
    await env.KV.put(`gen:${s.jobId}:assemble:retries`, "3");
    const { sent } = await deliver(s.message);
    expect(sent).toEqual([]);
    await expectFailed(s, "missing_text", "assemble: missing text after 20 retries");
    expect(await kvLeft(genKeys(s.jobId))).toEqual([]);
  });

  it("invalid images KV", async () => {
    const s = await setup({ images: "{not json" });
    await deliver(s.message);
    await expectFailed(s, "invalid_images_kv", "invalid images KV JSON");
  });

  it("invalid text KV", async () => {
    const s = await setup({ text: "{not json" });
    await deliver(s.message);
    await expectFailed(s, "invalid_text_kv", "invalid KV JSON");
  });

  it("text that fails validation", async () => {
    const s = await setup({ text: textPayload({ headline: "  " }) });
    await deliver(s.message);
    await expectFailed(s, "text_failed_validation", "assemble: text failed validation");
  });

  it("a candidate-store failure", async () => {
    const s = await setup({ shopStatus: "active", isActive: 1 });
    const live = await seedSite(s.shopId, "live", "The live headline");
    const h = hookedDb({ failBatchWhen: (q) => q.startsWith("INSERT INTO shop_site_candidates") });

    await deliver(s.message, { db: h.db });

    await expectFailed(s, "candidate_store_failed", /^assemble: could not store the new version for review; the live site was left unchanged: /);
    expect(await candidate(s.shopId)).toBeNull();
    const [row] = await sites(s.shopId);
    expect(row).toMatchObject({ headline: "The live headline", generated_at: live.generated_at });
    expect(await kvLeft(genKeys(s.jobId))).toEqual([]);
  });

  // WS-8: the assembler used to ALTER missing shop_sites columns in at runtime.
  // A database that missed a migration now fails the job, named, and the
  // assembler never touches the schema.
  it("a database that missed a migration, without changing the schema", async () => {
    const s = await setup();
    await env.DB.prepare("ALTER TABLE shop_sites DROP COLUMN heading_style").run();
    try {
      const h = hookedDb();
      await deliver(s.message, { db: h.db });
      await expectFailed(s, "schema_out_of_date", /shop_sites\.heading_style/);
      expect(h.prepared.filter((q) => /\b(ALTER|CREATE|DROP)\s+(TABLE|INDEX)\b/i.test(q))).toEqual([]);
      const cols = await env.DB.prepare("PRAGMA table_info(shop_sites)").all<{ name: string }>();
      expect((cols.results ?? []).map((c) => c.name)).not.toContain("heading_style");
    } finally {
      // Storage persists across tests in this file: put the chain's column back.
      await env.DB.prepare("ALTER TABLE shop_sites ADD COLUMN heading_style TEXT").run();
    }
  });

  it("a schema read that fails is a crash, not a missing migration", async () => {
    const s = await setup();
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) =>
            sql.startsWith("PRAGMA table_info")
              ? {
                  all: async () => {
                    throw new Error("D1_ERROR: network connection lost");
                  },
                }
              : target.prepare(sql);
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await deliver(s.message, { db });
    await expectFailed(s, "crash", "assemble: D1_ERROR: network connection lost");
  });

  it("a crash", async () => {
    const s = await setup();
    const kv = new Proxy(env.KV, {
      get(target, prop) {
        if (prop === "get") {
          return async () => {
            throw new Error("KV unavailable");
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as KVNamespace;
    const { acked } = await deliver(s.message, { kv });
    expect(acked).toBe(1);
    await expectFailed(s, "crash", "assemble: KV unavailable");
  });
});

describe("waiting for the upstream stages", () => {
  it("both wait-path re-sends carry origin_actor_ref", async () => {
    const waitingForText = await setup({ text: null });
    const t = await deliver(waitingForText.message);
    expect(t.sent).toEqual([{ body: waitingForText.message, options: { delaySeconds: 60 } }]);
    expect(await env.KV.get(`gen:${waitingForText.jobId}:assemble:text_retries`)).toBe("1");

    const waitingForImages = await setup({ images: null });
    const i = await deliver(waitingForImages.message);
    expect(i.sent).toEqual([{ body: waitingForImages.message, options: { delaySeconds: 60 } }]);
    expect(await env.KV.get(`gen:${waitingForImages.jobId}:assemble:retries`)).toBe("1");

    // Waiting ends nothing and records nothing.
    for (const s of [waitingForText, waitingForImages]) {
      expect((await job(s.jobId))?.status).toBe("running");
      expect(await completions(s.shopId)).toHaveLength(0);
    }
  });
});

describe("the shop_sites write (P14: no reliance on a unique index)", () => {
  // The pre-change statements (676b34e:apps/workers/builder/src/index.ts),
  // copied by hand: the site write must cover exactly what they wrote.
  const OLD_UPDATE_SET = [
    "headline", "tagline", "about", "services_json", "hero_image_url", "logo_url", "catalog_images_json",
    "color_primary", "color_accent", "font_heading", "font_body", "seo_title", "seo_description",
    "trust_signals_json", "usps_json", "layout_mood", "brand_voice", "hero_cta", "about_title", "palette_json",
    "heading_weight", "heading_style", "design_spec", "design_version", "gallery_images_json",
    "status", "generated_at",
  ];
  const OLD_INSERT = [
    "id", "shop_id", "template", "headline", "tagline", "about", "services_json",
    "color_primary", "color_accent", "font_heading", "font_body",
    "hero_image_url", "logo_url", "catalog_images_json", "generated_at", "status",
    "seo_title", "seo_description", "trust_signals_json", "usps_json", "layout_mood", "brand_voice",
    "hero_cta", "about_title", "palette_json", "heading_weight", "heading_style",
    "design_spec", "design_version", "gallery_images_json",
  ];
  const sorted = (xs: string[]) => [...xs].sort();
  const flat = (q: string) => q.replace(/\s+/g, " ").trim();

  it("the site UPDATE and INSERT write the same columns the old ones wrote", async () => {
    const s = await setup();
    const h = hookedDb();
    await deliver(s.message, { db: h.db });

    // The statements the worker actually sent, not constants it might not use.
    // This job has no owner palette, so the only shop_sites UPDATE is the site write.
    const updates = h.prepared.map(flat).filter((q) => q.startsWith("UPDATE shop_sites SET"));
    const inserts = h.prepared.map(flat).filter((q) => q.startsWith("INSERT INTO shop_sites"));
    expect(updates).toHaveLength(1);
    expect(inserts).toHaveLength(1);

    const u = updates[0]!.match(/^UPDATE shop_sites SET (.+) WHERE shop_id = \?$/);
    expect(u, updates[0]).not.toBeNull();
    const assignments = u![1]!.split(",").map((a) => a.trim().match(/^(\w+) = (.+)$/));
    expect(assignments.every(Boolean), updates[0]).toBe(true);
    const updated = assignments.map((a) => a![1]!);
    expect(new Set(updated).size).toBe(updated.length);
    expect(sorted(updated)).toEqual(sorted(OLD_UPDATE_SET));
    // id and template are insert-only; every column takes this publish's bound value.
    expect(updated).not.toContain("id");
    expect(updated).not.toContain("template");
    expect(updated).not.toContain("shop_id");
    expect(assignments.map((a) => a![2])).toEqual(updated.map(() => "?"));

    // Keyed on shop_id ALONE (no status filter), so it never adds a second row.
    const i = inserts[0]!.match(
      /^INSERT INTO shop_sites \(([^)]*)\) SELECT (.+) WHERE NOT EXISTS \(SELECT 1 FROM shop_sites WHERE shop_id = \?\)$/
    );
    expect(i, inserts[0]).not.toBeNull();
    const inserted = i![1]!.split(",").map((c) => c.trim());
    expect(new Set(inserted).size).toBe(inserted.length);
    expect(sorted(inserted)).toEqual(sorted(OLD_INSERT));
    expect(i![2]!.split(",").map((v) => v.trim())).toEqual(inserted.map(() => "?"));
  });

  // Replaces the earlier "migration 003's unique index is in the replayed
  // chain" test: publish no longer depends on that index.
  it("publishes without migration 003's unique index on shop_id", async () => {
    // Production may list 003 as applied by --baseline without its index
    // having run; the old UPDATE-then-INSERT never needed it, nor may this.
    await env.DB.prepare("DROP INDEX idx_shop_sites_shop_id").run();
    try {
      const indexes = await env.DB.prepare("PRAGMA index_list(shop_sites)").all<{ name: string; unique: number }>();
      for (const ix of (indexes.results ?? []).filter((x) => x.unique === 1)) {
        const cols = await env.DB.prepare(`PRAGMA index_info(${ix.name})`).all<{ name: string }>();
        expect((cols.results ?? []).map((c) => c.name), ix.name).not.toEqual(["shop_id"]);
      }

      const first = await setup({
        research: researchPayload({ template: "bold", owner_color_primary: "#123456", owner_color_accent: "#abcdef" }),
      });
      await deliver(first.message);
      const inserted = await sites(first.shopId);
      expect(inserted).toHaveLength(1);
      // The owner palette lands on the row the INSERT just created.
      expect(inserted[0]).toMatchObject({
        status: "active",
        template: "bold",
        headline: "Sharp cuts on Example Row",
        owner_color_primary: "#123456",
        owner_color_accent: "#abcdef",
      });
      expect(await job(first.jobId)).toEqual({ status: "complete", stage: "complete", error: null });

      const secondJob = await addJob(first.shopId, {
        text: textPayload({ headline: "Fresh fades on Example Row" }),
        images: imagesPayload(),
        research: researchPayload({ template: "classic" }),
      });
      await deliver({ ...first.message, jobId: secondJob });

      const rows = await sites(first.shopId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(inserted[0]!.id);
      expect(rows[0]!.template).toBe("bold");
      expect(rows[0]!.headline).toBe("Fresh fades on Example Row");
      expect(rows[0]!.generated_at).not.toBe(inserted[0]!.generated_at);
      expect(await job(secondJob)).toEqual({ status: "complete", stage: "complete", error: null });
      expect(await completions(first.shopId)).toHaveLength(2);
    } finally {
      // Storage persists across tests in this file: put the chain's index back.
      await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_sites_shop_id ON shop_sites(shop_id)").run();
    }
  });
});
