/**
 * Pure registry rules against the recorded vendor lists (no KV, no network):
 * ranking per group, price join, fallback order, key gating.
 */
import { describe, it, expect } from "vitest";
import type { AIModel } from "@repo/types";
import { MODEL_SNAPSHOT, catalogModels } from "@repo/utils";
import {
  anthropicCanonical,
  buildRegistry,
  fetchRegistrySources,
  priceKeyFor,
  rankAnthropicIds,
  rankOpenAiIds,
  rankOpenRouterText,
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
    expect(rankOpenAiIds(OPENAI_IDS)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
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
      "claude-fable-5.1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4.5",
    ]);
  });

  it("lets a fabricated claude-opus-6 displace Opus 5", () => {
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
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.8-flash",
      "google/gemini-3.5-flash-lite",
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "x-ai/grok-4.6",
      "x-ai/grok-4.20-multi-agent",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4.1-flash",
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
      "anthropic/claude-3-haiku",
      "anthropic/claude-opus-4.8",
      "x-ai/grok-build-0.1",
      "google/gemma-4-31b-it",
    ]) {
      expect(ranked).not.toContain(excluded);
    }
  });

  it("prefers a stable id over a preview at the same version and a newer preview over an older stable", () => {
    const withStablePro: OpenRouterFeedModel[] = [
      ...OPENROUTER_FEED,
      { id: "google/gemini-3.1-pro", pricing: { prompt: "0.000002", completion: "0.000012" }, supported_parameters: ["reasoning"], architecture: { output_modalities: ["text"] } },
    ];
    expect(rankOpenRouterText(withStablePro)).toContain("google/gemini-3.1-pro");
    expect(rankOpenRouterText(withStablePro)).not.toContain("google/gemini-3.1-pro-preview");
    // Without any 3.x pro, the stable 2.5 loses to the 3.1 preview (Decision 1).
    expect(rankOpenRouterText(OPENROUTER_FEED)).toContain("google/gemini-3.1-pro-preview");
    expect(rankOpenRouterText(OPENROUTER_FEED)).not.toContain("google/gemini-2.5-pro");
  });

  it("keeps the pinned defaults even when the feed no longer lists them", () => {
    const feed = OPENROUTER_FEED.filter((m) => m.id !== "google/gemini-3.1-flash-lite-preview" && m.id !== "anthropic/claude-sonnet-5");
    const ranked = rankOpenRouterText(feed);
    expect(ranked[0]).toBe("google/gemini-3.1-flash-lite-preview");
    expect(ranked).toContain("anthropic/claude-sonnet-5");
  });
});

describe("buildRegistry", () => {
  it("assembles the four groups in order with route, vendor, prices and effort levels", () => {
    const { models, warnings } = buildRegistry(allOk());
    expect(warnings).toEqual([]);
    expect(models).toHaveLength(29);
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
      effortLevels: ["low", "medium", "high"],
      recommended: false,
    });

    const sonnetDirect = models.find((m) => m.id === "anthropic-api/claude-sonnet-5")!;
    expect(sonnetDirect.name).toBe("Claude Sonnet 5");
    expect(sonnetDirect.effortLevels).toEqual(["medium", "high"]);
    expect(sonnetDirect.livePricing).toBe(true);
    expect(sonnetDirect.costPer1MInput).toBe(2);

    const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-5")!;
    expect(sonnet).toMatchObject({ provider: "openrouter", vendor: "anthropic", vendorLabel: "Anthropic", recommended: true, name: "Claude Sonnet 5" });
    expect(models.filter((m) => m.recommended).map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);

    const grok = models.find((m) => m.id === "x-ai/grok-4.6")!;
    expect(grok.name).toBe("Grok 4.6"); // vendor prefix stripped from the feed name
    expect(grok.effortLevels).toEqual(["low", "medium", "high"]);

    const image = models.find((m) => m.id === "google/gemini-3.1-flash-image")!;
    expect(image).toMatchObject({ kind: "image", provider: "openrouter", supportsEffort: false, effortLevels: [], livePricing: true, costPer1MInput: 0.5 });
  });

  it("hides a direct group when its key is missing and says so", () => {
    const { models, warnings } = buildRegistry({ ...allOk(), openai: { ok: false, reason: "no-key" } });
    expect(models.some((m) => m.provider === "openai")).toBe(false);
    expect(models.some((m) => m.provider === "anthropic")).toBe(true);
    expect(warnings).toEqual(["openai: API key not configured; group hidden"]);
  });

  it("keeps a group from the previous build when its fetch failed", () => {
    const previous: AIModel[] = buildRegistry(allOk()).models.map((m) =>
      m.id === "anthropic-api/claude-opus-5" ? { ...m, name: "Opus from cache" } : m,
    );
    const { models } = buildRegistry({ ...allOk(), anthropic: { ok: false, reason: "fetch-failed" }, previous });
    expect(models.find((m) => m.id === "anthropic-api/claude-opus-5")?.name).toBe("Opus from cache");
    expect(models.filter((m) => m.provider === "anthropic")).toHaveLength(4);
  });

  it("falls back to the snapshot for a failed group with no previous build, still priced from the feed", () => {
    const { models } = buildRegistry({ ...allOk(), openai: { ok: false, reason: "fetch-failed" } });
    const luna = models.find((m) => m.id === "openai-api/gpt-5.6-luna")!;
    expect(luna.livePricing).toBe(true);
    expect(luna.costPer1MInput).toBe(0.2);
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
    expect(models.find((m) => m.id === "anthropic/claude-sonnet-5")?.costPer1MInput).toBe(2);
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
    expect(checked).toBe(29);
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
