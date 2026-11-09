import { afterEach, describe, expect, it, vi } from "vitest";
import { completionEntryId } from "@repo/audit";
import { fakeAuditDb, type FakeAuditDbOptions } from "@repo/audit/testing";
import worker, { failJobAfterCrash } from "./index";

const MODEL = "google/gemini-3.1-flash-lite-preview"; // DEFAULT_TEXT_MODEL: no rescue attempt
const ORIGIN = "subj_user_u1";
const ABOUT = "We have been cutting hair on this corner for a long while.";

const research = (extra: Record<string, unknown> = {}) => ({
  spec: { content: { headline: "Fallback headline" }, image_prompts: { catalog: [] } },
  services: [{ name: "Cut", price_gbp: 20, duration_min: 30 }],
  jobId: "job-1",
  shopId: "shop-1",
  shopSlug: "test-cuts",
  shopName: "Test Cuts",
  shopType: "barber_shop",
  hasLogoFile: false,
  template: "t",
  ...extra,
});

const textOut = () => ({
  headline: "Sharp cuts, calm chairs",
  tagline: "A neighbourhood barber.",
  about: ABOUT,
  services: [{ name: "Cut", description: "A tidy cut." }],
  seo_title: "Test Cuts",
  seo_description: "Book a cut.",
  color_primary: "#112233",
  color_accent: "#c9a84c",
  font_heading: "Playfair Display",
  font_body: "DM Sans",
});

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 80 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const message = (extra: Record<string, unknown> = {}) => ({
  jobId: "job-1",
  shopId: "shop-1",
  shopSlug: "test-cuts",
  text_model: MODEL,
  origin_actor_ref: ORIGIN,
  ...extra,
});

function harness(opts: FakeAuditDbOptions = {}, researchPayload: unknown = research()) {
  const fake = fakeAuditDb(opts);
  const kv = new Map<string, string>();
  if (researchPayload !== null) kv.set("gen:job-1:research", JSON.stringify(researchPayload));
  const assemble: unknown[] = [];
  const env = {
    DB: fake.db,
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
    },
    SITE_ASSEMBLE_QUEUE: { send: async (m: unknown) => void assemble.push(m) },
    OPENROUTER_API_KEY: "test-key",
    ENVIRONMENT: "test",
  };
  const acked: boolean[] = [];
  const run = (body: unknown) =>
    worker.queue({ messages: [{ body, ack: () => acked.push(true) }] } as never, env as never);
  return { fake, kv, assemble, run, acked, env };
}

afterEach(() => vi.restoreAllMocks());

describe("text audit", () => {
  it("the copy call is an ai.call with purpose site_text and the origin", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(textOut())));
    const h = harness();
    await h.run(message());
    const calls = h.fake.rows.filter((r) => r.action === "ai.call");
    expect(calls.map((r) => r.phase)).toEqual(["started", "outcome"]);
    for (const r of calls) {
      const d = JSON.parse(r.details_json as string);
      expect(d.purpose).toBe("site_text");
      expect(d.origin_actor_ref).toBe(ORIGIN);
      expect(r.worker).toBe("pivot-parlor-text");
      expect(r.via).toBe("queue");
      expect(r.request_id).toBe("job-1");
    }
    const out = JSON.parse(calls[1]!.details_json as string);
    expect(out.input_tokens).toBe(120);
    expect(out.output_tokens).toBe(80);
    // The assembler finishes the job, not text.
    expect(h.fake.rows.some((r) => r.action === "site.regenerate.complete")).toBe(false);
    const dump = JSON.stringify(h.fake.rows);
    for (const secret of [ABOUT, "Sharp cuts, calm chairs", "You output JSON only", "Shop name:"]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("the assemble send carries origin_actor_ref", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(textOut())));
    const h = harness();
    await h.run(message());
    expect(h.assemble).toHaveLength(1);
    expect((h.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe(ORIGIN);
  });

  it("falls back to the research payload's origin, and to null without one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(textOut())));
    const a = harness({}, research({ origin_actor_ref: "subj_user_u9" }));
    await a.run(message({ origin_actor_ref: undefined }));
    expect((a.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBe("subj_user_u9");
    const b = harness();
    await b.run(message({ origin_actor_ref: undefined }));
    expect((b.assemble[0] as { origin_actor_ref: unknown }).origin_actor_ref).toBeNull();
    const started = b.fake.rows.find((r) => r.action === "ai.call")!;
    expect(JSON.parse(started.details_json as string).origin_actor_ref).toBeNull();
  });

  it("a refused audit write fails the job without calling the model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completion(JSON.stringify(textOut())));
    const h = harness({ failAuditWrites: "started" });
    await h.run(message());
    expect(fetchSpy).not.toHaveBeenCalled();
    const update = h.fake.statements.find(
      (s) => s.sql.startsWith("UPDATE generation_jobs SET status = ?") && s.args[0] === "failed"
    );
    expect(update).toBeDefined();
    expect(update!.args[1]).toBe("text");
    expect(update!.args[2]).toBe("Could not record this action; nothing was changed.");
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.reason).toBe("audit_refused");
    expect(h.assemble).toHaveLength(0);
    expect(h.acked).toEqual([true]);
  });

  it("a crash ends the job with one failed completion entry, even delivered twice", async () => {
    const h = harness({
      answer: (sql) => (sql.startsWith("SELECT status FROM generation_jobs") ? { status: "failed" } : null),
    });
    const body = message();
    await failJobAfterCrash(h.env as never, body, new Error("boom"));
    await expect(failJobAfterCrash(h.env as never, body, new Error("boom"))).resolves.toBeUndefined();
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe(await completionEntryId("job-1"));
    expect(done[0]!.outcome).toBe("failed");
    expect(done[0]!.reason).toBe("crash");
    expect(JSON.parse(done[0]!.details_json as string).stage).toBe("text");
    expect(JSON.parse(done[0]!.details_json as string).origin_actor_ref).toBe(ORIGIN);
    expect(JSON.stringify(done[0])).not.toContain("boom");
    const update = h.fake.statements.find((s) => s.sql.startsWith("UPDATE generation_jobs SET status = ?"));
    expect(update!.args[2]).toBe("text: boom");
  });

  it("missing research ends the job with one missing_research entry", async () => {
    const h = harness({}, null);
    await h.run(message());
    const done = h.fake.rows.filter((r) => r.action === "site.regenerate.complete");
    expect(done).toHaveLength(1);
    expect(done[0]!.reason).toBe("missing_research");
    const update = h.fake.statements.find((s) => s.sql.startsWith("UPDATE generation_jobs SET status = ?"));
    expect(String(update!.args[2])).toContain("research output missing");
    expect(h.assemble).toHaveLength(0);
  });

  it("when finishJob fails, the best-effort failed write still happens and is logged", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ failOnSql: /^UPDATE generation_jobs SET status = \?, stage = \?, error = \?, updated_at = \?/ });
    await expect(failJobAfterCrash(h.env as never, message(), new Error("boom"))).resolves.toBeUndefined();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[audit] job failed without its completion entry"))).toBe(true);
    const fallback = h.fake.statements.find((s) => s.sql.startsWith("UPDATE generation_jobs SET status = 'failed', stage = 'text'"));
    expect(fallback).toBeDefined();
    expect(fallback!.sql).toMatch(/status NOT IN \('complete', 'failed'\)/);
    expect(fallback!.args[0]).toBe("text: boom");
    expect(fallback!.args[2]).toBe("job-1");
  });
});
