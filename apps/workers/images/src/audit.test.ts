import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILED_JOB_FALLBACK_SQL } from "@repo/audit";
import { fakeAuditDb, type FakeAuditDbOptions } from "@repo/audit/testing";
import worker, { handOffAfterCrash } from "./index";

const MODEL = "google/gemini-test-image";
const ORIGIN = "subj_user_u1";
const HERO_PROMPT = "A sunlit barbershop interior with brass fittings";
const LOGO_PROMPT = "A minimal scissors monogram";
const CATALOG_PROMPT = "A fresh skin fade on a client";
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const research = (extra: Record<string, unknown> = {}) => ({
  spec: { image_prompts: { hero: HERO_PROMPT, logo: LOGO_PROMPT, catalog: [CATALOG_PROMPT] } },
  services: [{ name: "Cut" }],
  jobId: "job-1",
  shopId: "shop-1",
  shopSlug: "test-cuts",
  shopName: "Test Cuts",
  shopType: "barber_shop",
  hasLogoFile: false,
  template: "t",
  image_model: MODEL,
  ...extra,
});

/** What OpenRouter billed for one image (`usage.cost`, USD). */
const BILLED = 0.0672;

const imageResponse = (opts: { cost?: number | null; withImage?: boolean } = {}) => {
  const cost = opts.cost === undefined ? BILLED : opts.cost;
  const images = opts.withImage === false ? [] : [{ image_url: { url: `data:image/png;base64,${PNG_B64}` } }];
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: null, images } }],
      usage: { prompt_tokens: 11, completion_tokens: 22, ...(cost === null ? {} : { cost }) },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

/** The cost-log inserts, as [shop_id, worker, model, usage_type, in, out, total, cost, basis, job_id]. */
const usageRows = (h: { fake: { statements: { sql: string; args: unknown[] }[] } }) =>
  h.fake.statements.filter((s) => s.sql.includes("INSERT INTO ai_usage_log")).map((s) => s.args.slice(1));

const message = (extra: Record<string, unknown> = {}) => ({
  jobId: "job-1",
  shopId: "shop-1",
  shopSlug: "test-cuts",
  origin_actor_ref: ORIGIN,
  ...extra,
});

function harness(opts: FakeAuditDbOptions = {}, researchPayload: unknown = research()) {
  const fake = fakeAuditDb(opts);
  const kv = new Map<string, string>();
  if (researchPayload !== null) kv.set("gen:job-1:research", JSON.stringify(researchPayload));
  const assemble: unknown[] = [];
  const puts: string[] = [];
  const env = {
    DB: fake.db,
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
    },
    ASSETS: {
      get: async () => null,
      put: async (k: string) => {
        puts.push(k);
      },
    },
    SITE_ASSEMBLE_QUEUE: { send: async (m: unknown) => void assemble.push(m) },
    OPENROUTER_API_KEY: "test-key",
    ENVIRONMENT: "test",
    ASSET_BASE_URL: "https://assets.test",
  };
  const acked: boolean[] = [];
  const run = (body: unknown) =>
    worker.queue({ messages: [{ body, ack: () => acked.push(true) }] } as never, env as never);
  return { fake, kv, assemble, puts, run, acked, env };
}

afterEach(() => vi.restoreAllMocks());

const aiCalls = (h: ReturnType<typeof harness>) => h.fake.rows.filter((r) => r.action === "ai.call");

describe("images audit", () => {
  it("each generated image is one ai.call with its purpose", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    const h = harness();
    await h.run(message());
    const calls = aiCalls(h);
    expect(calls).toHaveLength(6); // hero, logo, catalog_0: started + outcome each
    const purposes = calls.filter((r) => r.phase === "started").map((r) => JSON.parse(r.details_json as string).purpose);
    expect(purposes).toEqual(["site_image_hero", "site_image_logo", "site_image_catalog_0"]);
    for (const r of calls) {
      const d = JSON.parse(r.details_json as string);
      expect(d.origin_actor_ref).toBe(ORIGIN);
      expect(d.model).toBe(MODEL);
      expect(r.worker).toBe("pivot-parlor-images");
      expect(r.request_id).toBe("job-1");
    }
    const out = JSON.parse(calls.filter((r) => r.phase === "outcome")[0]!.details_json as string);
    expect(out.input_tokens).toBe(11);
    expect(out.output_tokens).toBe(22);
    expect(out.estimated_cost_usd).toBe(BILLED);
    expect(out.cost_basis).toBe("reported");
    expect(h.puts).toHaveLength(3);
    // The assembler finishes the job, not images.
    expect(h.fake.rows.some((r) => r.action === "site.regenerate.complete")).toBe(false);
    const dump = JSON.stringify(h.fake.rows);
    for (const secret of [HERO_PROMPT, LOGO_PROMPT, CATALOG_PROMPT, PNG_B64]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("each answered image writes one cost-log row with the billed cost, correlated to its ai.call", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    const h = harness();
    await h.run(message());
    // worker + job id are what the historical import's live-twin exclusion
    // matches on, so these rows are never imported a second time.
    expect(usageRows(h)).toEqual(
      ["site_image_hero", "site_image_logo", "site_image_catalog_0"].map((purpose) => [
        "shop-1", "pivot-parlor-images", MODEL, purpose, 11, 22, 33, BILLED, "reported", "job-1",
      ])
    );
  });

  it("an image with no billed cost stays unpriced, even when the model list prices the model", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse({ cost: null }));
    const h = harness();
    // A list price would use the text completion rate, far below image output.
    h.kv.set("ai:models:v3", JSON.stringify([{ id: MODEL, costPer1MInput: 0.5, costPer1MOutput: 3, livePricing: true }]));
    await h.run(message());
    for (const r of aiCalls(h).filter((c) => c.phase === "outcome")) {
      const d = JSON.parse(r.details_json as string);
      expect(d.estimated_cost_usd).toBeNull();
      expect(d.cost_basis).toBeNull();
    }
    const rows = usageRows(h);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.slice(7, 9)).toEqual([0, null]);
  });

  it("an answered call that returns no image still records what it cost", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse({ withImage: false }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    await h.run(message());
    for (const r of aiCalls(h).filter((c) => c.phase === "outcome")) expect(r.outcome).toBe("failed");
    expect(usageRows(h).map((row) => [row[3], row[7], row[8]])).toEqual([
      ["site_image_hero", BILLED, "reported"],
      ["site_image_logo", BILLED, "reported"],
      ["site_image_catalog_0", BILLED, "reported"],
    ]);
    expect(h.assemble).toHaveLength(1);
  });

  it("every assemble send carries origin_actor_ref", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    const normal = harness();
    await normal.run(message());
    expect((normal.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);

    const skip = harness();
    await skip.run(message({ skip_images: true }));
    expect((skip.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);

    const noResearch = harness({}, null);
    await noResearch.run(message());
    expect((noResearch.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);

    const crash = harness();
    await handOffAfterCrash(crash.env as never, message(), new Error("boom"));
    expect((crash.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);
  });

  it("falls back to the research payload's origin, and to null without one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    const a = harness({}, research({ origin_actor_ref: "subj_user_u9" }));
    await a.run(message({ origin_actor_ref: undefined }));
    expect((a.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe("subj_user_u9");
    const b = harness();
    await b.run(message({ origin_actor_ref: undefined }));
    expect((b.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBeNull();
  });

  it("a refused audit write fails the job instead of assembling without images", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    const h = harness({ failAuditWrites: "started" });
    await h.run(message());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(usageRows(h)).toEqual([]);
    expect(h.puts).toHaveLength(0);
    expect(h.assemble).toHaveLength(0);
    expect(h.kv.has("gen:job-1:images")).toBe(false);
    const update = h.fake.statements.find(
      (s) => s.sql.startsWith("UPDATE generation_jobs SET status = ?") && s.args[0] === "failed"
    );
    expect(update).toBeDefined();
    expect(update!.args[1]).toBe("images");
    expect(update!.args[2]).toBe("Could not record this action; nothing was changed.");
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.outcome).toBe("failed");
    expect(done[0]!.reason).toBe("audit_refused");
    expect(h.acked).toEqual([true]);
  });

  it("a failed image still assembles without it, as today", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("provider says: SECRET-PROVIDER-BODY", { status: 500 })
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    await h.run(message());
    const outcomes = aiCalls(h).filter((r) => r.phase === "outcome");
    expect(outcomes).toHaveLength(3);
    for (const r of outcomes) {
      expect(r.outcome).toBe("failed");
      expect(r.reason).toBe("ImageGenerationError (HTTP 500)");
    }
    // An error response is not billed: nothing goes to the cost log.
    expect(usageRows(h)).toEqual([]);
    expect(h.assemble).toHaveLength(1);
    const payload = JSON.parse(h.kv.get("gen:job-1:images")!);
    expect(payload.errors.map((e: { step: string }) => e.step)).toEqual([
      "hero_openrouter",
      "logo_openrouter",
      "catalog_0_openrouter",
    ]);
    expect(payload.errors[0].detail).toContain("SECRET-PROVIDER-BODY");
    expect(JSON.stringify(h.fake.rows)).not.toContain("SECRET-PROVIDER-BODY");
    expect(h.fake.rows.some((r) => r.action === "site.regenerate.complete")).toBe(false);
  });

  it("a non-audit crash keeps the hand-off and writes no completion entry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness();
    await handOffAfterCrash(h.env as never, message(), new Error("boom"));
    expect(h.assemble).toHaveLength(1);
    expect(JSON.parse(h.kv.get("gen:job-1:images")!).errors[0].step).toBe("crash");
    expect(h.fake.rows.some((r) => r.action === "site.regenerate.complete")).toBe(false);
  });

  it("when finishJob fails, the best-effort failed write still happens and is logged", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    const h = harness({
      failAuditWrites: "started",
      failOnSql: /^UPDATE generation_jobs SET status = \?, stage = \?, error = \?, updated_at = \?/,
    });
    await h.run(message());
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[audit] job failed without its completion entry"))).toBe(true);
    // The shared guarded fallback: status 'failed' is in the SQL; binds are stage, error, updated_at, id.
    const fallback = h.fake.statements.find((s) => s.sql === FAILED_JOB_FALLBACK_SQL);
    expect(fallback).toBeDefined();
    expect(fallback!.sql).toContain("status = 'failed'");
    expect(fallback!.sql).toContain("COALESCE(status, 'queued') NOT IN ('complete', 'failed')");
    expect(fallback!.args[0]).toBe("images");
    expect(fallback!.args[1]).toBe("Could not record this action; nothing was changed.");
    expect(fallback!.args[3]).toBe("job-1");
    expect(h.assemble).toHaveLength(0);
  });
});
