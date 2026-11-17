/**
 * Pure registry rules against the recorded vendor lists (no KV, no network):
 * ranking per group, price join, fallback order, key gating.
 */
import { describe, it, expect } from "vitest";
import type { AIModel } from "@repo/types";
import { MODEL_SNAPSHOT, catalogModels } from "@repo/utils";
import { costFromModelList } from "@repo/llm";
import { EFFORT_LEVELS as LLM_EFFORT_LEVELS } from "@repo/llm";
import { EFFORT_LEVELS as UTILS_EFFORT_LEVELS } from "@repo/utils";
import {
  anthropicCanonical,
  anthropicEfforts,
  buildRegistry,
  driftWarnings,
  effortFor,
  feedEfforts,
  fetchRegistrySources,
  priceKeyFor,
  rankAnthropicIds,
  rankOpenAiIds,
  rankOpenRouterText,
  type AnthropicListedModel,
  type OpenRouterFeedModel,
  type RegistryInputs,
} from "../src/services/model-registry";
import { ANTHROPIC_MODELS, OPENAI_IDS, OPENROUTER_FEED, feedResponses } from "./fixtures/model-feeds";

const allOk = (): RegistryInputs => ({
  openrouter: { ok: true, data: OPENROUTER_FEED },
  openai: { ok: true, data: OPENAI_IDS },
  anthropic: { ok: true, data: ANTHROPIC_MODELS },
  previous: null,
});

const round3 = (n: number) => Math.round(n * 1000) / 1000;

describe("rankOpenAiIds", () => {
  it("keeps the newest generation of each of the four tiers, in tier order", () => {
    expect(rankOpenAiIds(OPENAI_IDS)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);
  });

  it("lets a fabricated gpt-7-astra displace gpt-6-astra and ignores -pro, chat-latest and image ids", () => {
    const ranked = rankOpenAiIds([...OPENAI_IDS, "gpt-7-astra", "gpt-7-astra-pro"]);
    expect(ranked[0]).toBe("gpt-7-astra");
    expect(ranked).not.toContain("gpt-7-astra-pro");
    expect(ranked).not.toContain("gpt-chat-latest");
    expect(ranked).not.toContain("gpt-5-image-mini");
  });
});

describe("rankAnthropicIds", () => {
  it("keeps the highest version per family in fable, opus, sonnet, haiku order", () => {
    expect(rankAnthropicIds(ANTHROPIC_MODELS.map((m) => m.id))).toEqual([
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
  });

  it("lets a fabricated claude-opus-6 displace Opus 5.5", () => {
    expect(rankAnthropicIds([...ANTHROPIC_MODELS.map((m) => m.id), "claude-opus-6"])[1]).toBe("claude-opus-6");
  });

  it("reads hyphenated and dated ids, preferring the undated alias at equal versions", () => {
    expect(rankAnthropicIds(["claude-sonnet-4-6-20260210", "claude-sonnet-4-6", "claude-sonnet-4-5"])).toEqual(["claude-sonnet-4-6"]);
    expect(rankAnthropicIds(["claude-sonnet-4-6-20260210"])).toEqual(["claude-sonnet-4-6-20260210"]);
    expect(anthropicCanonical("claude-sonnet-4-6-20260210")).toBe("claude-sonnet-4.6");
    expect(anthropicCanonical("claude-opus-5")).toBe("claude-opus-5");
    expect(anthropicCanonical("claude-3-haiku-20240307")).toBeNull();
    expect(priceKeyFor("anthropic-api/claude-sonnet-4-6-20260210")).toBe("anthropic/claude-sonnet-4.6");
    expect(priceKeyFor("openai-api/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(priceKeyFor("x-ai/grok-4.6")).toBe("x-ai/grok-4.6");
  });
});

describe("rankOpenRouterText", () => {
  it("produces the top tier per family per vendor, vendors in catalogue order, defaults pinned", () => {
    expect(rankOpenRouterText(OPENROUTER_FEED)).toEqual([
      "google/gemini-3.1-flash-lite-preview",
      "google/gemini-4-carbon",
      "google/gemini-4-argon",
      "google/gemini-4-hydrogen",
      "google/gemini-3.8-flash",
      "google/gemini-3.5-flash-lite",
      "anthropic/claude-fable-5.2",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6-astra",
      "openai/gpt-6.1-sol",
      "openai/gpt-6.1-terra",
      "openai/gpt-6-luna",
      "x-ai/grok-4.7",
      "x-ai/grok-4.20-multi-agent",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4.1-flash",
      "z-ai/glm-5.3-prime",
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-flash",
      "qwen/qwen4-max",
      "qwen/qwen3.7-plus",
      "qwen/qwen3.8-flash",
      "mistralai/mistral-large-4-0",
      "mistralai/mistral-medium-3-5",
    ]);
  });

  it("matches the snapshot's OpenRouter text ids exactly", () => {
    expect(rankOpenRouterText(OPENROUTER_FEED)).toEqual(
      MODEL_SNAPSHOT.filter((m) => m.provider === "openrouter" && m.kind === "text").map((m) => m.id),
    );
  });

  it("excludes :variants, -pro, -exp, dated ids, non-text models and legacy families", () => {
    const ranked = rankOpenRouterText(OPENROUTER_FEED);
    for (const excluded of [
      "google/gemini-3.8-flash:batch",
      "openai/gpt-6-astra-pro",
      "deepseek/deepseek-v3.2-exp",
      "deepseek/deepseek-v4-pro-0813",
      "deepseek/deepseek-v4-flash-0731",
      "google/gemini-3.1-flash-image",
      "google/gemini-omni-1.2-flash",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.8",
      "openai/gpt-6.1-terra-pro",
      "x-ai/grok-build-0.1",
      "google/gemma-4-31b-it",
      "deepseek/deepseek-v4.1-flash-1017",
      "z-ai/glm-5.3-flashx-legal",
      "qwen/qwen3.8-max-0902",
      "qwen/qwen3.8-max-prime",
      "mistralai/mistral-large-2512",
      "mistralai/mistral-small-2603",
    ]) {
      expect(ranked).not.toContain(excluded);
    }
  });

  it("prefers a stable id over a preview at the same version and a newer preview over an older stable", () => {
    const text = (id: string): OpenRouterFeedModel => ({
      id,
      pricing: { prompt: "0.000002", completion: "0.00001" },
      supported_parameters: ["reasoning"],
      architecture: { output_modalities: ["text"] },
    });
    const withSamePreview = [...OPENROUTER_FEED, text("google/gemini-4-carbon-preview")];
    expect(rankOpenRouterText(withSamePreview)).toContain("google/gemini-4-carbon");
    expect(rankOpenRouterText(withSamePreview)).not.toContain("google/gemini-4-carbon-preview");
    const withNewerPreview = [...OPENROUTER_FEED, text("google/gemini-4.5-carbon-preview")];
    expect(rankOpenRouterText(withNewerPreview)).toContain("google/gemini-4.5-carbon-preview");
    expect(rankOpenRouterText(withNewerPreview)).not.toContain("google/gemini-4-carbon");
  });

  it("puts Gemini 4 Carbon in the flagship slot over the Gemini 3 Pro line, and keeps 3.8 Flash beside Hydrogen", () => {
    const ranked = rankOpenRouterText(OPENROUTER_FEED);
    expect(ranked).toContain("google/gemini-4-carbon");
    expect(ranked).not.toContain("google/gemini-3.1-pro-preview");
    expect(ranked).not.toContain("google/gemini-2.5-pro");
    // Hydrogen costs about twice 3.8 Flash, so the cheaper Flash stays listed.
    expect(ranked).toContain("google/gemini-4-hydrogen");
    expect(ranked).toContain("google/gemini-3.8-flash");
    // Without Gemini 4, the 3.1 Pro preview still beats the stable 2.5 Pro.
    const noGemini4 = OPENROUTER_FEED.filter((m) => !m.id.startsWith("google/gemini-4-"));
    expect(rankOpenRouterText(noGemini4)).toContain("google/gemini-3.1-pro-preview");
  });

  it("reads Mistral's hyphenated versions", () => {
    // 3-5 beats 3.1 and 3 in the recorded feed; a 4-0 would beat 3-5.
    expect(rankOpenRouterText(OPENROUTER_FEED)).toContain("mistralai/mistral-medium-3-5");
    const ranked = rankOpenRouterText([
      ...OPENROUTER_FEED,
      { id: "mistralai/mistral-medium-4-0", architecture: { output_modalities: ["text"] } },
    ]);
    expect(ranked).toContain("mistralai/mistral-medium-4-0");
    expect(ranked).not.toContain("mistralai/mistral-medium-3-5");
    // Versions compare as decimals, so "3-10" reads as 3.1 (xAI's 4.20 predates
    // its 4.3, which this ordering gets right); see the audit notes.
  });

  it("keeps the pinned defaults even when the feed no longer lists them", () => {
    const feed = OPENROUTER_FEED.filter((m) => m.id !== "google/gemini-3.1-flash-lite-preview" && m.id !== "anthropic/claude-sonnet-5.5");
    const ranked = rankOpenRouterText(feed);
    expect(ranked[0]).toBe("google/gemini-3.1-flash-lite-preview");
    expect(ranked).toContain("anthropic/claude-sonnet-5.5");
  });
});

describe("driftWarnings", () => {
  const DAY = 24 * 3600;
  const newest = Math.max(...OPENROUTER_FEED.map((m) => m.created ?? 0));
  const gemini = (id: string, created: number): OpenRouterFeedModel => ({ id, created, architecture: { output_modalities: ["text"] } });

  it("is quiet on the recorded feed", () => {
    expect(driftWarnings(OPENROUTER_FEED, rankOpenRouterText(OPENROUTER_FEED))).toEqual([]);
  });

  it("names a vendor's newest model when no rule matches it and it is more than a week newer than every pick", () => {
    const feed = [...OPENROUTER_FEED, gemini("google/gemini-5-neon", newest + 30 * DAY)];
    expect(driftWarnings(feed, rankOpenRouterText(feed))).toEqual([
      expect.stringMatching(/^google: newest model google\/gemini-5-neon \(\d{4}-\d{2}-\d{2}\) is not listed/),
    ]);
  });

  it("would have caught Gemini 4 under the old Gemini 3 rules", () => {
    const oldRulesPicks = rankOpenRouterText(OPENROUTER_FEED).filter((id) => !id.startsWith("google/gemini-4-"));
    expect(driftWarnings(OPENROUTER_FEED, oldRulesPicks).some((w) => w.startsWith("google: newest model google/gemini-4-hydrogen"))).toBe(true);
  });

  it("ignores a model released within a week of a pick, and specialist lines", () => {
    const googleNewestPick = Math.max(...OPENROUTER_FEED.filter((m) => m.id.startsWith("google/gemini-4-")).map((m) => m.created ?? 0));
    const soon = [...OPENROUTER_FEED, gemini("google/gemini-5-neon", googleNewestPick + 3 * DAY)];
    expect(driftWarnings(soon, rankOpenRouterText(soon))).toEqual([]);
    const legal = [...OPENROUTER_FEED, gemini("z-ai/glm-9-legal", newest + 30 * DAY)];
    expect(driftWarnings(legal, rankOpenRouterText(legal))).toEqual([]);
  });
});

describe("effort levels", () => {
  const feedById = new Map(OPENROUTER_FEED.map((m) => [m.id, m]));

  it("keeps the two ladders in step", () => {
    expect([...UTILS_EFFORT_LEVELS]).toEqual([...LLM_EFFORT_LEVELS]);
  });

  it("reads the feed's levels in ladder order, with the reported default", () => {
    expect(feedEfforts(feedById.get("deepseek/deepseek-v4-pro"))).toEqual({ levels: ["none", "high", "xhigh"], defaultEffort: "high" });
    expect(feedEfforts(feedById.get("z-ai/glm-5.3"))).toEqual({ levels: ["low", "high", "max"], defaultEffort: "max" });
  });

  it("gives no select to a reasoning block without levels, and the old three to a feed entry without a block", () => {
    expect(feedEfforts(feedById.get("qwen/qwen3.7-plus"))).toEqual({ levels: [], defaultEffort: null });
    expect(feedEfforts({ id: "x/legacy", supported_parameters: ["max_tokens", "reasoning"] })).toEqual({ levels: ["low", "medium", "high"], defaultEffort: null });
    expect(feedEfforts({ id: "x/plain", supported_parameters: ["max_tokens"] })).toEqual({ levels: [], defaultEffort: null });
    expect(feedEfforts(undefined)).toBeUndefined();
  });

  it("drops a default the model does not list", () => {
    expect(feedEfforts({ id: "x/odd", reasoning: { supported_efforts: ["low", "high"], default_effort: "medium" } })).toEqual({ levels: ["low", "high"], defaultEffort: null });
  });

  it("reads Anthropic's capability tree, with no default and no none or minimal", () => {
    const listed = (effort: unknown): AnthropicListedModel => ({ id: "claude-x-1", capabilities: { effort } as AnthropicListedModel["capabilities"] });
    const twin = feedById.get("anthropic/claude-haiku-5.5");
    expect(anthropicEfforts(listed({ supported: false }), twin)).toEqual({ levels: [], defaultEffort: null });
    expect(
      anthropicEfforts(listed({ supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: null, max: { supported: true } }), twin),
    ).toEqual({ levels: ["low", "medium", "high", "max"], defaultEffort: null });
    // No capabilities: the OpenRouter twin's levels without its "none".
    expect(anthropicEfforts({ id: "claude-haiku-5-5", capabilities: null }, twin)).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null });
    expect(anthropicEfforts({ id: "claude-x-1" }, undefined)).toEqual({ levels: ["low", "medium", "high"], defaultEffort: null });
  });

  it("sends only a level the model takes", () => {
    const deepseek = { effortLevels: ["none", "high", "xhigh"] as const }.effortLevels;
    expect(effortFor({ effortLevels: [...deepseek] }, "xhigh")).toEqual({ effort: "xhigh", dropped: null });
    expect(effortFor({ effortLevels: [...deepseek] }, "medium")).toEqual({ effort: undefined, dropped: "medium" });
    expect(effortFor({ effortLevels: [] }, "high")).toEqual({ effort: undefined, dropped: "high" });
    expect(effortFor({ effortLevels: [...deepseek] }, undefined)).toEqual({ effort: undefined, dropped: null });
  });
});

// The research and text workers price their calls for the cost log by reading
// this list back out of KV (packages/llm/src/usage.ts). Guard the contract
// between the two shapes, and that the cost matches the audit's ai.call figure.
describe("cost log pricing from the served list", () => {
  const stored = (models: AIModel[]): unknown => JSON.parse(JSON.stringify(models));
  const auditCost = (m: AIModel, input: number, output: number) =>
    Math.round(((input * m.costPer1MInput + output * m.costPer1MOutput) / 1_000_000) * 1_000_000) / 1_000_000;

  it("prices a live-priced model the same way the audit entry does", () => {
    const { models } = buildRegistry(allOk());
    const astra = models.find((m) => m.id === "openai-api/gpt-6-astra")!;
    expect(costFromModelList(stored(models), astra.id, { inputTokens: 12_345, outputTokens: 6_789 })).toEqual({
      costUsd: auditCost(astra, 12_345, 6_789),
      basis: "live",
    });
  });

  it("labels a snapshot-priced model catalog", () => {
    const { models } = buildRegistry({ ...allOk(), openrouter: { ok: false, reason: "fetch-failed" } });
    const snap = models.find((m) => !m.livePricing && (m.costPer1MInput > 0 || m.costPer1MOutput > 0));
    expect(snap, "expected a snapshot-priced model when the feed is down").toBeDefined();
    expect(costFromModelList(stored(models), snap!.id, { inputTokens: 1_000, outputTokens: 1_000 })).toEqual({
      costUsd: auditCost(snap!, 1_000, 1_000),
      basis: "catalog",
    });
  });
});

describe("buildRegistry", () => {
  it("assembles the four groups in order with route, vendor, prices and effort levels", () => {
    const { models, warnings } = buildRegistry(allOk());
    expect(warnings).toEqual([]);
    expect(models).toHaveLength(39);
    expect(models.map((m) => m.id)).toEqual(MODEL_SNAPSHOT.map((m) => m.id));

    const astra = models.find((m) => m.id === "openai-api/gpt-6-astra")!;
    expect(astra).toMatchObject({
      provider: "openai",
      providerLabel: "OpenAI API",
      vendor: "openai",
      vendorLabel: "OpenAI",
      kind: "text",
      name: "GPT-6 Astra",
      costPer1MInput: 10,
      costPer1MOutput: 50,
      livePricing: true,
      supportsEffort: true,
      // From the OpenRouter twin: GPT-6 Astra takes no "none".
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      recommended: false,
    });
    expect(models.find((m) => m.id === "openai-api/gpt-6-luna")?.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);

    const sonnetDirect = models.find((m) => m.id === "anthropic-api/claude-sonnet-5-5")!;
    expect(sonnetDirect.name).toBe("Claude Sonnet 5.5");
    expect(sonnetDirect.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(sonnetDirect.defaultEffort).toBeUndefined();
    expect(sonnetDirect.livePricing).toBe(true);
    expect(sonnetDirect.costPer1MInput).toBe(2);

    const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-5.5")!;
    expect(sonnet).toMatchObject({ provider: "openrouter", vendor: "anthropic", vendorLabel: "Anthropic", recommended: true, name: "Claude Sonnet 5.5" });
    expect(models.filter((m) => m.recommended).map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5"]);

    const grok = models.find((m) => m.id === "x-ai/grok-4.7")!;
    expect(grok.name).toBe("Grok 4.7"); // vendor prefix stripped from the feed name
    expect(grok.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(grok.defaultEffort).toBe("high");

    const qwenPlus = models.find((m) => m.id === "qwen/qwen3.7-plus")!;
    expect(qwenPlus).toMatchObject({ vendorLabel: "Qwen", supportsEffort: false, effortLevels: [] });
    expect(models.find((m) => m.id === "z-ai/glm-5.3")).toMatchObject({ vendorLabel: "Z.ai", defaultEffort: "max" });
    expect(models.find((m) => m.id === "mistralai/mistral-large-4-0")?.vendorLabel).toBe("Mistral");

    const image = models.find((m) => m.id === "google/gemini-3.1-flash-image")!;
    expect(image).toMatchObject({ kind: "image", provider: "openrouter", supportsEffort: false, effortLevels: [], livePricing: true, costPer1MInput: 0.5 });
  });

  it("serves the snapshot's effort levels and defaults exactly as the registry builds them", () => {
    const { models } = buildRegistry(allOk());
    const built = models.map((m) => ({ id: m.id, levels: m.effortLevels, def: m.defaultEffort ?? null }));
    const snap = MODEL_SNAPSHOT.map((m) => ({
      id: m.id,
      levels: m.supportsEffort ? (m.effortLevels ?? ["low", "medium", "high"]) : [],
      def: m.defaultEffort ?? null,
    }));
    expect(snap).toEqual(built);
  });

  it("skips a retired Anthropic model", () => {
    const retired: AnthropicListedModel = { id: "claude-opus-9", display_name: "Claude Opus 9", lifecycle: "retired", capabilities: null };
    const { models } = buildRegistry({ ...allOk(), anthropic: { ok: true, data: [...ANTHROPIC_MODELS, retired] } });
    expect(models.some((m) => m.id === "anthropic-api/claude-opus-9")).toBe(false);
    expect(models.some((m) => m.id === "anthropic-api/claude-opus-5-5")).toBe(true);
  });

  it("warns when a listed model is scheduled to leave OpenRouter", () => {
    const feed = OPENROUTER_FEED.map((m) => (m.id === "x-ai/grok-4.7" ? { ...m, expiration_date: "2026-12-31" } : m));
    const { warnings } = buildRegistry({ ...allOk(), openrouter: { ok: true, data: feed } });
    expect(warnings).toEqual(["openrouter: x-ai/grok-4.7 is scheduled to leave OpenRouter on 2026-12-31"]);
  });

  it("hides a direct group when its key is missing and says so", () => {
    const { models, warnings } = buildRegistry({ ...allOk(), openai: { ok: false, reason: "no-key" } });
    expect(models.some((m) => m.provider === "openai")).toBe(false);
    expect(models.some((m) => m.provider === "anthropic")).toBe(true);
    expect(warnings).toEqual(["openai: API key not configured; group hidden"]);
  });

  it("keeps a group from the previous build when its fetch failed", () => {
    const previous: AIModel[] = buildRegistry(allOk()).models.map((m) =>
      m.id === "anthropic-api/claude-opus-5-5" ? { ...m, name: "Opus from cache" } : m,
    );
    const { models } = buildRegistry({ ...allOk(), anthropic: { ok: false, reason: "fetch-failed" }, previous });
    expect(models.find((m) => m.id === "anthropic-api/claude-opus-5-5")?.name).toBe("Opus from cache");
    expect(models.filter((m) => m.provider === "anthropic")).toHaveLength(4);
  });

  it("falls back to the snapshot for a failed group with no previous build, still priced from the feed", () => {
    const { models } = buildRegistry({ ...allOk(), openai: { ok: false, reason: "fetch-failed" } });
    const luna = models.find((m) => m.id === "openai-api/gpt-6-luna")!;
    expect(luna.livePricing).toBe(true);
    expect(luna.costPer1MInput).toBe(0.1);
    // The snapshot carries the levels, so the offline group matches the live one.
    expect(luna.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("serves the whole snapshot with fallback prices when every source failed", () => {
    const { models } = buildRegistry({
      openrouter: { ok: false, reason: "fetch-failed" },
      openai: { ok: false, reason: "fetch-failed" },
      anthropic: { ok: false, reason: "fetch-failed" },
      previous: null,
    });
    expect(models.map((m) => m.id)).toEqual(MODEL_SNAPSHOT.map((m) => m.id));
    expect(models.every((m) => m.livePricing === false)).toBe(true);
    expect(models.find((m) => m.id === "anthropic/claude-sonnet-5.5")?.costPer1MInput).toBe(2);
    expect(models.find((m) => m.id === "anthropic-api/claude-haiku-5-5")?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("marks a live id nobody can price as unavailable rather than free", () => {
    const { models } = buildRegistry({ ...allOk(), openai: { ok: true, data: [...OPENAI_IDS, "gpt-7-astra"] } });
    const astra7 = models.find((m) => m.id === "openai-api/gpt-7-astra")!;
    expect(astra7).toMatchObject({ name: "GPT-7 Astra", costPer1MInput: 0, costPer1MOutput: 0, livePricing: false });
  });

  it("warns when a fetched group ranks fewer than two models (naming drift)", () => {
    const { warnings } = buildRegistry({ ...allOk(), openai: { ok: true, data: ["gpt-6-astra", "gpt-4o"] } });
    expect(warnings.some((w) => w.startsWith("openai: only 1 text model"))).toBe(true);
  });

  it("keeps the snapshot's fallback prices equal to the recorded feed", () => {
    const feedById = new Map(OPENROUTER_FEED.map((m) => [m.id, m]));
    let checked = 0;
    for (const m of catalogModels()) {
      const twin = feedById.get(priceKeyFor(m.id));
      if (!twin) continue;
      checked++;
      expect(m.fallbackInput, m.id).toBe(round3(Number(twin.pricing!.prompt) * 1e6));
      expect(m.fallbackOutput, m.id).toBe(round3(Number(twin.pricing!.completion) * 1e6));
    }
    expect(checked).toBe(39);
  });
});

describe("fetchRegistrySources", () => {
  function recordingFetch() {
    const urls: string[] = [];
    const headers: Record<string, Record<string, string>> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      headers[url] = Object.fromEntries(new Headers(init?.headers).entries());
      if (url.startsWith("https://openrouter.ai/")) return feedResponses.openrouter();
      if (url.startsWith("https://api.openai.com/")) return feedResponses.openai();
      if (url.startsWith("https://api.anthropic.com/")) return feedResponses.anthropic();
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    return { fetchImpl, urls, headers };
  }

  it("fetches all three lists with the right auth headers when every key is set", async () => {
    const f = recordingFetch();
    const sources = await fetchRegistrySources({ openrouter: "or", openai: "oa", anthropic: "an" }, f.fetchImpl);
    expect(sources.openrouter.ok && sources.openrouter.data.length).toBe(OPENROUTER_FEED.length);
    expect(sources.openai).toEqual({ ok: true, data: OPENAI_IDS });
    expect(sources.anthropic.ok).toBe(true);
    expect(f.headers["https://api.openai.com/v1/models"]?.authorization).toBe("Bearer oa");
    const anthropicUrl = f.urls.find((u) => u.startsWith("https://api.anthropic.com/"))!;
    expect(anthropicUrl).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(f.headers[anthropicUrl]?.["x-api-key"]).toBe("an");
    expect(f.headers[anthropicUrl]?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("skips a vendor entirely when its key is missing", async () => {
    const f = recordingFetch();
    const sources = await fetchRegistrySources({ openrouter: "or" }, f.fetchImpl);
    expect(sources.openai).toEqual({ ok: false, reason: "no-key" });
    expect(sources.anthropic).toEqual({ ok: false, reason: "no-key" });
    expect(f.urls.some((u) => u.includes("api.openai.com") || u.includes("api.anthropic.com"))).toBe(false);
  });

  it("reports a failed fetch without throwing", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://api.openai.com/")) return new Response("nope", { status: 500 });
      if (String(input).startsWith("https://openrouter.ai/")) return feedResponses.openrouter();
      return feedResponses.anthropic();
    }) as typeof fetch;
    const sources = await fetchRegistrySources({ openrouter: "or", openai: "oa", anthropic: "an" }, fetchImpl);
    expect(sources.openai).toEqual({ ok: false, reason: "fetch-failed" });
    expect(sources.openrouter.ok).toBe(true);
  });
});
