import { afterEach, describe, expect, it, vi } from "vitest";
import { completionEntryId, FAILED_JOB_FALLBACK_SQL } from "@repo/audit";
import { fakeAuditDb, type FakeAuditDbOptions } from "@repo/audit/testing";
import worker from "./index";

const MODEL = "google/gemini-3.1-flash-lite-preview"; // DEFAULT_TEXT_MODEL: no rescue attempt, so exactly 2 attempts
const ORIGIN = "subj_user_u1";
const HEADLINE = "Sharp cuts, calm chairs";

const spec = () => ({
  palette: { primary: "#112233", accent: "#c9a84c", background: "#ffffff", text: "#111111", muted: "#666666" },
  typography: { heading_font: "Playfair Display", body_font: "DM Sans", heading_weight: "700", heading_style: "serif" },
  layout_mood: "luxury-dark",
  brand_voice: "Warm and precise.",
  content: {
    headline: HEADLINE,
    subheadline: "A neighbourhood barber with room to breathe.",
    hero_cta: "Book Your Cut",
    about_title: "About the shop",
    about_body: "We cut hair.",
    trust_signals: ["Book online, any time"],
    unique_selling_points: ["Every price shown up front"],
    seo_title: "Test Cuts",
    seo_description: "Book a cut.",
  },
  image_prompts: { hero: "h", logo: "l", catalog: [] },
  legal_content: { privacy_policy: "p", terms_of_service: "t", cookie_policy: "c" },
  social_stubs: {},
});

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 80 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function message(extra: Record<string, unknown> = {}) {
  return {
    jobId: "job-1",
    shopId: "shop-1",
    shopName: "Test Cuts",
    shopType: "barber_shop",
    shopSlug: "test-cuts",
    styleNotes: "secret style notes",
    services: [],
    business: {},
    hasLogoFile: false,
    text_model: MODEL,
    image_model: "google/gemini-3.1-flash-image",
    origin_actor_ref: ORIGIN,
    ...extra,
  };
}

function harness(opts: FakeAuditDbOptions = {}, envExtra: Record<string, unknown> = {}) {
  const fake = fakeAuditDb(opts);
  const kv = new Map<string, string>();
  const sends: Record<"images" | "text" | "assemble", unknown[]> = { images: [], text: [], assemble: [] };
  const queue = (k: keyof typeof sends) => ({
    send: async (m: unknown) => {
      sends[k].push(m);
    },
  });
  const env = {
    DB: fake.db,
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
    },
    SITE_IMAGES_QUEUE: queue("images"),
    SITE_TEXT_QUEUE: queue("text"),
    SITE_ASSEMBLE_QUEUE: queue("assemble"),
    OPENROUTER_API_KEY: "test-key",
    ENVIRONMENT: "test",
    ...envExtra,
  };
  const acked: boolean[] = [];
  const run = (body: unknown) =>
    worker.queue({ messages: [{ body, ack: () => acked.push(true) }] } as never, env as never);
  return { fake, kv, sends, run, acked };
}

afterEach(() => vi.restoreAllMocks());

describe("research audit", () => {
  it("each model attempt is an ai.call carrying who clicked", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(spec())));
    const h = harness();
    await h.run(message());
    const calls = h.fake.rows.filter((r) => r.action === "ai.call");
    expect(calls.map((r) => r.phase)).toEqual(["started", "outcome"]);
    for (const r of calls) {
      const d = JSON.parse(r.details_json as string);
      expect(d.purpose).toBe("site_research");
      expect(d.origin_actor_ref).toBe(ORIGIN);
      expect(r.worker).toBe("pivot-parlor-research");
      expect(r.via).toBe("queue");
      expect(r.request_id).toBe("job-1");
    }
    const out = JSON.parse(calls[1]!.details_json as string);
    expect(out.input_tokens).toBe(120);
    expect(out.output_tokens).toBe(80);
    expect(calls[1]!.outcome).toBe("succeeded");
    // Research never ends a job successfully.
    expect(h.fake.rows.some((r) => r.action === "site.regenerate.complete")).toBe(false);
    // No prompt or reply text in any audit row.
    const dump = JSON.stringify(h.fake.rows);
    for (const secret of [HEADLINE, "secret style notes", "world-class brand strategist", "Shop name:"]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("origin_actor_ref rides every message and the research payload", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(spec())));
    const h = harness();
    await h.run(message());
    expect(h.sends.images).toHaveLength(1);
    expect(h.sends.text).toHaveLength(1);
    expect((h.sends.images[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);
    expect((h.sends.text[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);
    expect(JSON.parse(h.kv.get("gen:job-1:research")!).origin_actor_ref).toBe(ORIGIN);

    const s = harness();
    await s.run(message({ skip_images: true }));
    expect(s.sends.assemble).toHaveLength(1);
    expect((s.sends.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);
    expect((s.sends.text[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);
  });

  it("a message from before the deploy records null and still runs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(spec())));
    const h = harness();
    const body = message();
    delete (body as Record<string, unknown>).origin_actor_ref;
    await h.run(body);
    const calls = h.fake.rows.filter((r) => r.action === "ai.call");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.details_json as string).origin_actor_ref).toBeNull();
    expect(h.sends.text).toHaveLength(1);
    expect((h.sends.text[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBeNull();
  });

  it("a refused audit write stops the job before any model call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(spec())));
    const h = harness({ failAuditWrites: "started" });
    await h.run(message());
    expect(fetchSpy).not.toHaveBeenCalled();
    const update = h.fake.statements.find(
      (s) => s.sql.startsWith("UPDATE generation_jobs SET status = ?") && s.args[0] === "failed"
    );
    expect(update).toBeDefined();
    expect(update!.args[1]).toBe("research");
    expect(update!.args[2]).toBe("Could not record this action; nothing was changed.");
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.reason).toBe("audit_refused");
    expect(h.sends.images).toHaveLength(0);
    expect(h.sends.text).toHaveLength(0);
    expect(h.sends.assemble).toHaveLength(0);
    expect(h.acked).toEqual([true]);
  });

  it("a job with no valid spec ends with one failed completion entry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion("not json at all"));
    const h = harness();
    await h.run(message());
    expect(fetchSpy).toHaveBeenCalledTimes(2); // default model: two attempts, no rescue
    const calls = h.fake.rows.filter((r) => r.action === "ai.call");
    expect(calls).toHaveLength(4);
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.outcome).toBe("failed");
    expect(done[0]!.id).toBe(await completionEntryId("job-1"));
    expect(done[0]!.reason).toBe("no_valid_spec");
    expect(JSON.parse(done[0]!.details_json as string).stage).toBe("research");
    expect(JSON.stringify(done[0])).not.toContain("not json at all");
    const update = h.fake.statements.find((s) => s.sql.startsWith("UPDATE generation_jobs SET status = ?"));
    expect(String(update!.args[2])).toContain("could not produce a valid spec after 2 attempts");
    expect(JSON.parse(h.kv.get("job:job-1")!).status).toBe("failed");
  });

  it("a missing API key ends the job with a not_configured entry", async () => {
    const h = harness({}, { OPENROUTER_API_KEY: "" });
    await h.run(message());
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.reason).toBe("not_configured");
  });

  it("a crash after the model calls ends the job with a crash entry", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(spec())));
    const h = harness({ failOnSql: /research_output/ });
    await h.run(message());
    // failOnSql matches the research_output UPDATE only; the terminal write is a different statement.
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.reason).toBe("crash");
  });

  it("when finishJob itself fails, the best-effort failed write still happens and is logged", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion("nope"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ failOnSql: /^UPDATE generation_jobs SET status = \?, stage = \?, error = \?, updated_at = \?/ });
    await h.run(message());
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[audit] job failed without its completion entry"))).toBe(true);
    // The shared guarded fallback: status 'failed' is in the SQL; binds are stage, error, updated_at, id.
    const fallback = h.fake.statements.find((s) => s.sql === FAILED_JOB_FALLBACK_SQL);
    expect(fallback).toBeDefined();
    expect(fallback!.sql).toContain("status = 'failed'");
    expect(fallback!.sql).toContain("COALESCE(status, 'queued') NOT IN ('complete', 'failed')");
    expect(fallback!.args[0]).toBe("research");
    expect(String(fallback!.args[1])).toContain("could not produce a valid spec after 2 attempts");
    expect(fallback!.args[3]).toBe("job-1");
    expect(JSON.parse(h.kv.get("job:job-1")!).status).toBe("failed");
  });

  it("an already finished job skips the mirror write", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion("nope"));
    const h = harness({
      failOnSql: /^UPDATE generation_jobs SET status = \?, stage = \?, error = \?, updated_at = \? WHERE id = \? AND/,
      answer: (sql) => (sql.startsWith("SELECT status FROM generation_jobs") ? { status: "failed" } : null),
    });
    await h.run(message());
    expect(h.kv.get("job:job-1")).not.toContain('"failed"');
  });
});
