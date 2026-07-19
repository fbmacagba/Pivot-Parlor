/**
 * OpenRouter-backed model catalogue for the developer AI tools.
 *
 * WHICH models are offered is defined by the shared `MODEL_CATALOG` in
 * `@repo/utils` (consumed here via `catalogModels`/`findCatalogModel`) so the
 * worker and web pickers stay in sync. Pricing and reasoning-effort support
 * are refreshed at read time from the public OpenRouter catalogue and cached
 * in KV for an hour; when OpenRouter is unreachable the fallback values from
 * the shared catalogue are served instead (marked livePricing: false).
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  catalogModels,
  findCatalogModel,
  type ModelKind,
  type TextEffort,
} from "@repo/utils";

export type { TextEffort };

export interface AIModel {
  id: string;
  name: string;
  kind: ModelKind;
  provider: string;
  providerLabel: string;
  description: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  supportsEffort: boolean;
  recommended: boolean;
  livePricing: boolean;
}

/** Default model for the theme generator (site pipeline default lives in shops.ts). */
export const DEFAULT_THEME_MODEL = "anthropic/claude-sonnet-5";

const MODELS_KV_KEY = "ai:models:openrouter:v2";
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

/** Join the shared catalog with the live OpenRouter catalogue (pure; unit-tested). */
export function mergeLiveModels(live: OpenRouterCatalogueModel[]): AIModel[] {
  const byId = new Map(live.map((m) => [m.id, m]));
  return catalogModels().map((c) => {
    const lm = byId.get(c.id);
    const promptUsd = lm?.pricing?.prompt != null ? Number(lm.pricing.prompt) : NaN;
    const completionUsd = lm?.pricing?.completion != null ? Number(lm.pricing.completion) : NaN;
    const hasLive = Number.isFinite(promptUsd) && Number.isFinite(completionUsd);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      provider: c.provider,
      providerLabel: c.providerLabel,
      description: c.description,
      costPer1MInput: hasLive ? round3(promptUsd * 1e6) : c.fallbackInput,
      costPer1MOutput: hasLive ? round3(completionUsd * 1e6) : c.fallbackOutput,
      supportsEffort: lm?.supported_parameters
        ? lm.supported_parameters.includes("reasoning")
        : c.supportsEffort,
      recommended: c.recommended === true,
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
export function getModel(modelId: string, kind?: ModelKind): AIModel | undefined {
  if (kind && !findCatalogModel(modelId, kind)) return undefined;
  return fallbackModels().find((m) => m.id === modelId);
}

export function parseTextEffort(v: unknown): TextEffort | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}
