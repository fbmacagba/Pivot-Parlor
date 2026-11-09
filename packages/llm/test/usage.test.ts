import { describe, expect, it, vi } from "vitest";
import {
  MODELS_KV_KEY,
  MODELS_LAST_GOOD_KV_KEY,
  costFromModelList,
  readModelList,
  recordAiUsage,
  type UsageDb,
} from "../src/usage";

const LIST = [
  { id: "google/gemini-3.1-flash-lite-preview", costPer1MInput: 0.1, costPer1MOutput: 0.4, livePricing: true },
  { id: "anthropic-api/claude-sonnet-5", costPer1MInput: 3, costPer1MOutput: 15, livePricing: false },
  { id: "free/model", costPer1MInput: 0, costPer1MOutput: 0, livePricing: false },
];

function kvWith(values: Record<string, string | null>) {
  return { get: vi.fn(async (key: string) => values[key] ?? null) };
}

function fakeDb(run: () => Promise<unknown> = async () => ({})) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db: UsageDb = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        calls.push({ sql, values });
        return { run };
      },
    }),
  };
  return { db, calls };
}

describe("costFromModelList", () => {
  it("prices a live-priced model", () => {
    expect(costFromModelList(LIST, "google/gemini-3.1-flash-lite-preview", { inputTokens: 10_000, outputTokens: 2_000 })).toEqual({
      costUsd: 0.0018,
      basis: "live",
    });
  });

  it("marks a snapshot price as catalog", () => {
    expect(costFromModelList(LIST, "anthropic-api/claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000 })).toEqual({
      costUsd: 4.5,
      basis: "catalog",
    });
  });

  it("returns null for an unlisted model, a 0/0 price or a list that isn't one", () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    expect(costFromModelList(LIST, "nope/model", usage)).toBeNull();
    expect(costFromModelList(LIST, "free/model", usage)).toBeNull();
    expect(costFromModelList({ models: LIST }, "google/gemini-3.1-flash-lite-preview", usage)).toBeNull();
    expect(costFromModelList([{ id: "x", costPer1MInput: "1", costPer1MOutput: 2 }], "x", usage)).toBeNull();
  });
});

describe("readModelList", () => {
  it("prefers the fresh copy", async () => {
    const kv = kvWith({ [MODELS_KV_KEY]: JSON.stringify(LIST), [MODELS_LAST_GOOD_KV_KEY]: "[]" });
    expect(await readModelList(kv)).toHaveLength(3);
  });

  it("falls back to the last good copy when the fresh one is missing or unreadable", async () => {
    expect(await readModelList(kvWith({ [MODELS_LAST_GOOD_KV_KEY]: JSON.stringify(LIST) }))).toHaveLength(3);
    expect(await readModelList(kvWith({ [MODELS_KV_KEY]: "{not json", [MODELS_LAST_GOOD_KV_KEY]: JSON.stringify(LIST) }))).toHaveLength(3);
  });

  it("returns null when neither copy is usable", async () => {
    expect(await readModelList(kvWith({}))).toBeNull();
    expect(await readModelList(kvWith({ [MODELS_KV_KEY]: "{}" }))).toBeNull();
  });
});

describe("recordAiUsage", () => {
  const base = {
    shopId: "shop-1",
    workerName: "pivot-parlor-text",
    modelId: "google/gemini-3.1-flash-lite-preview",
    usageType: "site_text",
    jobId: "job-1",
  };

  it("writes tokens, cost and its basis", async () => {
    const { db, calls } = fakeDb();
    await recordAiUsage({ DB: db, KV: kvWith({ [MODELS_KV_KEY]: JSON.stringify(LIST) }) }, { ...base, usage: { inputTokens: 10_000, outputTokens: 2_000 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO ai_usage_log");
    const [, shopId, worker, model, type, input, output, total, cost, basis, jobId] = calls[0]!.values;
    expect([shopId, worker, model, type, input, output, total, cost, basis, jobId]).toEqual([
      "shop-1", "pivot-parlor-text", "google/gemini-3.1-flash-lite-preview", "site_text", 10_000, 2_000, 12_000, 0.0018, "live", "job-1",
    ]);
  });

  it("records an unpriced call as cost 0 with no basis, never as priced", async () => {
    const { db, calls } = fakeDb();
    await recordAiUsage({ DB: db, KV: kvWith({}) }, { ...base, usage: { inputTokens: 5, outputTokens: 5 } });
    expect(calls[0]!.values.slice(5, 10)).toEqual([5, 5, 10, 0, null]);
  });

  it("records a call with no token counts as zero tokens and no basis", async () => {
    const { db, calls } = fakeDb();
    const kv = kvWith({ [MODELS_KV_KEY]: JSON.stringify(LIST) });
    await recordAiUsage({ DB: db, KV: kv }, { ...base, usage: null });
    expect(calls[0]!.values.slice(5, 10)).toEqual([0, 0, 0, 0, null]);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("still records tokens when reading prices throws", async () => {
    const { db, calls } = fakeDb();
    const log = vi.fn();
    const kv = { get: vi.fn(async () => { throw new Error("kv down"); }) };
    await recordAiUsage({ DB: db, KV: kv }, { ...base, usage: { inputTokens: 3, outputTokens: 4 } }, log);
    expect(calls[0]!.values.slice(5, 10)).toEqual([3, 4, 7, 0, null]);
  });

  it("returns the cost it wrote", async () => {
    const { db, calls } = fakeDb();
    const result = await recordAiUsage(
      { DB: db, KV: kvWith({ [MODELS_KV_KEY]: JSON.stringify(LIST) }) },
      { ...base, usage: { inputTokens: 10_000, outputTokens: 2_000 } }
    );
    expect(result).toEqual({ costUsd: 0.0018, basis: "live" });
    expect(result?.costUsd).toBe(calls[0]!.values[8]);
    expect(result?.basis).toBe(calls[0]!.values[9]);
  });

  it("returns null for an unpriced call", async () => {
    const { db, calls } = fakeDb();
    const result = await recordAiUsage({ DB: db, KV: kvWith({}) }, { ...base, usage: { inputTokens: 5, outputTokens: 5 } });
    expect(result).toBeNull();
    expect(calls[0]!.values.slice(8, 10)).toEqual([0, null]);
  });

  it("never throws when the insert fails, and says so", async () => {
    const { db } = fakeDb(async () => { throw new Error("no such column: cost_basis"); });
    const log = vi.fn();
    await expect(
      recordAiUsage({ DB: db, KV: kvWith({}) }, { ...base, usage: { inputTokens: 1, outputTokens: 1 } }, log)
    ).resolves.toBeNull();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain("could not record usage");
  });
});
