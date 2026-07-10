/**
 * OpenRouter-backed model catalogue for the developer AI tools.
 *
 * The curated list below is the source of truth for WHICH models are offered
 * (top 10 providers, one flagship each — kept small so a developer can pick at
 * a glance and so the theme endpoint can't be used as a proxy to arbitrary
 * expensive models). Pricing and reasoning-effort support are refreshed at
 * read time from the public OpenRouter catalogue and cached in KV for an hour;
 * when OpenRouter is unreachable the fallback values below are served instead
 * (marked livePricing: false).
 */
import type { KVNamespace } from "@cloudflare/workers-types";

export type TextEffort = "low" | "medium" | "high";

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  description: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  supportsEffort: boolean;
  recommended: boolean;
  livePricing: boolean;
}

interface CuratedEntry {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  description: string;
  fallbackInput: number;
  fallbackOutput: number;
  fallbackSupportsEffort: boolean;
  recommended: boolean;
}

/** Fallback pricing snapshot taken from the OpenRouter catalogue on 2026-07-10. */
export const CURATED_MODELS: CuratedEntry[] = [
  {
    id: "google/gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite",
    provider: "google",
    providerLabel: "Google",
    description: "Pipeline default. Fast and very cheap; solid site copy.",
    fallbackInput: 0.25,
    fallbackOutput: 1.5,
    fallbackSupportsEffort: true,
    recommended: false,
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    providerLabel: "Anthropic",
    description: "Best copy quality for the price. Recommended for client-facing sites.",
    fallbackInput: 2.0,
    fallbackOutput: 10.0,
    fallbackSupportsEffort: true,
    recommended: true,
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    providerLabel: "OpenAI",
    description: "Strong creative writing and layout sense.",
    fallbackInput: 2.5,
    fallbackOutput: 15.0,
    fallbackSupportsEffort: true,
    recommended: false,
  },
  {
    id: "x-ai/grok-4.5",
    name: "Grok 4.5",
    provider: "x-ai",
    providerLabel: "xAI",
    description: "Punchy, direct copy. Good price for a frontier model.",
    fallbackInput: 2.0,
    fallbackOutput: 6.0,
    fallbackSupportsEffort: true,
    recommended: false,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    providerLabel: "DeepSeek",
    description: "Near-frontier quality at budget pricing.",
    fallbackInput: 0.435,
    fallbackOutput: 0.87,
    fallbackSupportsEffort: true,
    recommended: false,
  },
  {
    id: "meta-llama/llama-4-maverick",
    name: "Llama 4 Maverick",
    provider: "meta-llama",
    providerLabel: "Meta",
    description: "Cheapest open-weights option. No reasoning effort.",
    fallbackInput: 0.15,
    fallbackOutput: 0.6,
    fallbackSupportsEffort: false,
    recommended: false,
  },
  {
    id: "mistralai/mistral-medium-3-5",
    name: "Mistral Medium 3.5",
    provider: "mistralai",
    providerLabel: "Mistral",
    description: "Balanced European model with clean, concise output.",
    fallbackInput: 1.5,
    fallbackOutput: 7.5,
    fallbackSupportsEffort: true,
    recommended: false,
  },
  {
    id: "qwen/qwen3.7-max",
    name: "Qwen 3.7 Max",
    provider: "qwen",
    providerLabel: "Qwen",
    description: "Top Qwen tier; strong multilingual copy.",
    fallbackInput: 1.25,
    fallbackOutput: 3.75,
    fallbackSupportsEffort: true,
    recommended: false,
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    provider: "moonshotai",
    providerLabel: "Moonshot",
    description: "Creative long-form writing at mid-range pricing.",
    fallbackInput: 0.66,
    fallbackOutput: 3.41,
    fallbackSupportsEffort: true,
    recommended: false,
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM 5.2",
    provider: "z-ai",
    providerLabel: "Z.AI",
    description: "Capable generalist; one of the cheapest reasoning models.",
    fallbackInput: 0.42,
    fallbackOutput: 1.32,
    fallbackSupportsEffort: true,
    recommended: false,
  },
];

/** Default model for the theme generator (site pipeline default lives in shops.ts). */
export const DEFAULT_THEME_MODEL = "anthropic/claude-sonnet-5";

const MODELS_KV_KEY = "ai:models:openrouter:v1";
const MODELS_KV_TTL = 3600; // 1h — pricing moves slowly; avoids hammering the catalogue
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface OpenRouterCatalogueModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Join the curated list with the live OpenRouter catalogue (pure; unit-tested). */
export function mergeLiveModels(live: OpenRouterCatalogueModel[]): AIModel[] {
  const byId = new Map(live.map((m) => [m.id, m]));
  return CURATED_MODELS.map((c) => {
    const lm = byId.get(c.id);
    const promptUsd = lm?.pricing?.prompt != null ? Number(lm.pricing.prompt) : NaN;
    const completionUsd = lm?.pricing?.completion != null ? Number(lm.pricing.completion) : NaN;
    const hasLive = Number.isFinite(promptUsd) && Number.isFinite(completionUsd);
    return {
      id: c.id,
      name: c.name,
      provider: c.provider,
      providerLabel: c.providerLabel,
      description: c.description,
      costPer1MInput: hasLive ? round3(promptUsd * 1e6) : c.fallbackInput,
      costPer1MOutput: hasLive ? round3(completionUsd * 1e6) : c.fallbackOutput,
      supportsEffort: lm?.supported_parameters
        ? lm.supported_parameters.includes("reasoning")
        : c.fallbackSupportsEffort,
      recommended: c.recommended,
      livePricing: hasLive,
    };
  });
}

export function fallbackModels(): AIModel[] {
  return mergeLiveModels([]);
}

/** Curated model list with live pricing, KV-cached for an hour. */
export async function getLiveModels(kv: KVNamespace): Promise<AIModel[]> {
  const cached = await kv.get(MODELS_KV_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as AIModel[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* fall through to refetch */
    }
  }

  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
    const data = (await res.json()) as { data?: OpenRouterCatalogueModel[] };
    if (!Array.isArray(data.data) || data.data.length === 0) {
      throw new Error("OpenRouter models: empty catalogue");
    }
    const merged = mergeLiveModels(data.data);
    await kv.put(MODELS_KV_KEY, JSON.stringify(merged), { expirationTtl: MODELS_KV_TTL });
    return merged;
  } catch (err) {
    console.warn("[model-registry] live catalogue unavailable, serving fallback:", err);
    return fallbackModels();
  }
}

/** Look up a curated model (fallback values) — used for validation, not display. */
export function getModel(modelId: string): AIModel | undefined {
  return fallbackModels().find((m) => m.id === modelId);
}

export function parseTextEffort(v: unknown): TextEffort | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}
