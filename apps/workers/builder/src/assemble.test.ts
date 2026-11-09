/**
 * The assembler's write decision, run through the real queue handler with an
 * in-memory D1/KV double that records every statement:
 *  - a live or paused site is never overwritten: the result is stored as the
 *    shop's pending version (migration 049) and the job finishes at "review";
 *  - a draft is still written in place, exactly as before;
 *  - a missing candidate table fails the job with a named error and leaves
 *    the live site alone;
 *  - a crash records the job as failed instead of leaving it "running".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageBatch } from "@cloudflare/workers-types";
import { SHOP_SITES_REQUIRED_COLUMNS } from "./ensure-schema";
import worker, { type Env } from "./index";

type Call = { sql: string; args: unknown[] };
type SiteState = "live" | "paused" | "draft" | null | "none";

const JOB = "job-0001";
const SHOP = "shop-0001";
const SLUG = "test-barber";

function fakeEnv(opts: { site: SiteState; candidateTableMissing?: boolean; auditTableMissing?: boolean; kvThrows?: boolean }) {
  const calls: Call[] = [];
  const kv = new Map<string, string>();
  const kvDeleted: string[] = [];

  // A recorded fake D1 statement (not a shell call).
  const statement = (sql: string, args: unknown[]) => ({
    async run() {
      calls.push({ sql, args });
      if (opts.candidateTableMissing && sql.includes("shop_site_candidates")) {
        throw new Error("D1_ERROR: no such table: shop_site_candidates: SQLITE_ERROR");
      }
      if (opts.auditTableMissing && sql.startsWith("INSERT INTO audit_log")) {
        throw new Error("D1_ERROR: no such table: audit_log: SQLITE_ERROR");
      }
      return { meta: { changes: 1 } };
    },
    async first() {
      calls.push({ sql, args });
      if (sql.includes("FROM generation_jobs")) return { status: "running" };
      if (sql.includes("FROM shop_sites")) {
        if (opts.site === "none") return null;
        return {
          website_status: opts.site,
          hero_image_url: "https://img.test/old-hero.png",
          logo_url: null,
          locked_images_json: null,
          catalog_images_json: "[]",
          gallery_images_json: null,
          services_json: "[]",
        };
      }
      return null;
    },
    // The assembler's schema check: a migrated shop_sites.
    async all() {
      calls.push({ sql, args });
      if (sql === "PRAGMA table_info(shop_sites)") {
        return { results: SHOP_SITES_REQUIRED_COLUMNS.map((name) => ({ name })) };
      }
      return { results: [] };
    },
  });

  const DB = {
    prepare(sql: string) {
      return { ...statement(sql, []), bind: (...args: unknown[]) => statement(sql, args) };
    },
    // All or nothing, as D1's is: a failing statement leaves no call recorded.
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      const mark = calls.length;
      try {
        const out: unknown[] = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      } catch (e) {
        calls.length = mark;
        throw e;
      }
    },
  };
  const KV = {
    async get(key: string) {
      if (opts.kvThrows) throw new Error("KV unavailable");
      return kv.get(key) ?? null;
    },
    async put(key: string, value: string) {
      kv.set(key, value);
    },
    async delete(key: string) {
      kvDeleted.push(key);
      kv.delete(key);
    },
  };
  const queued: unknown[] = [];
  const env = {
    DB,
    KV,
    SITE_ASSEMBLE_QUEUE: { async send(m: unknown) { queued.push(m); } },
    ENVIRONMENT: "test",
  } as unknown as Env;

  kv.set(
    `gen:${JOB}:text`,
    JSON.stringify({
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
      completedAt: "2026-11-06T00:00:00Z",
    })
  );
  kv.set(
    `gen:${JOB}:images`,
    JSON.stringify({
      heroUrl: "https://img.test/new-hero.png",
      logoUrl: "",
      catalogUrls: ["https://img.test/fade.png"],
      galleryUrls: [],
      completedAt: "2026-11-06T00:00:00Z",
      errors: [],
    })
  );

  return { env, calls, kvDeleted, queued };
}

async function runOnce(env: Env) {
  let acked = 0;
  const batch = {
    messages: [{ body: { jobId: JOB, shopId: SHOP, shopSlug: SLUG }, ack: () => void acked++ }],
  } as unknown as MessageBatch<unknown>;
  await worker.queue(batch, env);
  return { acked };
}

const writes = (calls: Call[], prefix: string) => calls.filter((c) => c.sql.trimStart().startsWith(prefix));
const jobUpdates = (calls: Call[]) => writes(calls, "UPDATE generation_jobs");

describe("assembler write target", () => {
  // The failure paths log (with stack traces); keep them out of the run.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["live", "paused"] as const)("stores a %s site's regeneration for review and leaves the site alone", async (site) => {
    const { env, calls, kvDeleted } = fakeEnv({ site });
    const { acked } = await runOnce(env);
    expect(acked).toBe(1);

    const candidate = writes(calls, "INSERT INTO shop_site_candidates");
    expect(candidate).toHaveLength(1);
    const [shopId, jobId, payloadJson] = candidate[0]!.args as [string, string, string];
    expect([shopId, jobId]).toEqual([SHOP, JOB]);
    const payload = JSON.parse(payloadJson) as { version: number; columns: Record<string, unknown>; service_names: string[] };
    expect(payload.version).toBe(1);
    expect(payload.columns.headline).toBe("Sharp cuts on Example Row");
    expect(payload.columns.hero_image_url).toBe("https://img.test/new-hero.png");
    expect(payload.service_names).toEqual(["Skin fade"]);

    // Nothing public changed: no site write, no shop activation, no cache bust.
    expect(writes(calls, "UPDATE shop_sites")).toHaveLength(0);
    expect(writes(calls, "INSERT INTO shop_sites")).toHaveLength(0);
    expect(writes(calls, "UPDATE shops")).toHaveLength(0);
    expect(kvDeleted).not.toContain(`site:${SLUG}`);

    const done = jobUpdates(calls).at(-1)!;
    expect(done.args).toContain("complete");
    expect(done.args).toContain("review");
    expect(kvDeleted).toContain(`gen:${JOB}:text`);
  });

  it.each(["draft", null] as const)("writes a %s site in place, as before", async (site) => {
    const { env, calls, kvDeleted } = fakeEnv({ site });
    await runOnce(env);
    expect(writes(calls, "INSERT INTO shop_site_candidates")).toHaveLength(0);
    // UPDATE by shop_id, then INSERT only where no row exists (P14).
    expect(writes(calls, "UPDATE shop_sites SET\n")).toHaveLength(1);
    expect(writes(calls, "INSERT INTO shop_sites")).toHaveLength(1);
    expect(writes(calls, "UPDATE shops")).toHaveLength(1);
    expect(kvDeleted).toContain(`site:${SLUG}`);
    const done = jobUpdates(calls).at(-1)!;
    expect(done.args).toContain("complete");
    expect(done.args).not.toContain("review");
  });

  it("fails the job by name when the candidate table is missing, and leaves the site alone", async () => {
    const { env, calls } = fakeEnv({ site: "live", candidateTableMissing: true });
    await runOnce(env);
    expect(writes(calls, "UPDATE shop_sites")).toHaveLength(0);
    const failed = jobUpdates(calls).at(-1)!;
    expect(failed.args).toContain("failed");
    expect(failed.args.some((a) => typeof a === "string" && a.includes("migration 049"))).toBe(true);
  });

  it("does not blame migration 049 when a different table is missing", async () => {
    const { env, calls } = fakeEnv({ site: "live", auditTableMissing: true });
    await runOnce(env);
    expect(writes(calls, "INSERT INTO shop_site_candidates")).toHaveLength(0);
    const failed = jobUpdates(calls).at(-1)!;
    const error = failed.args.find((a): a is string => typeof a === "string" && a.startsWith("assemble:"));
    expect(error).toMatch(/^assemble: could not store the new version for review; the live site was left unchanged: .*no such table: audit_log/);
    expect(error).not.toMatch(/migration 049/);
  });

  it("records a crash as a failed job instead of leaving it running", async () => {
    const { env, calls } = fakeEnv({ site: "live", kvThrows: true });
    const { acked } = await runOnce(env);
    expect(acked).toBe(1);
    const failed = jobUpdates(calls);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.sql).toMatch(/NOT IN \('complete', 'failed'\)/);
    expect(failed[0]!.args[0]).toBe("failed");
    expect(failed[0]!.args[2]).toBe("assemble: KV unavailable");
    expect(failed[0]!.args.at(-1)).toBe(JOB);
  });
});
