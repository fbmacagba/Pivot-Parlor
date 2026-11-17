/**
 * Model snapshot: the last-resort fallback and fallback price table for the
 * live model registry (apps/worker/src/services/model-registry.ts), and the
 * offline list the web pickers use when the API is unreachable.
 *
 * The registry discovers the lists live and ranks them by rule; this file
 * only has to be a faithful picture of what the rules produced when it was
 * recorded. Prices are USD per 1M tokens and effort levels are the feed's
 * `reasoning` block, recorded 2026-11-17 from the public OpenRouter feed
 * (direct ids through their OpenRouter twin; direct Anthropic levels follow
 * the Models API). The worker test `model-registry.test.ts` checks this list
 * against what the registry builds from the recorded feed fixture
 * (apps/worker/test/fixtures/model-feeds.ts), so refresh both together.
 */

/** Reasoning effort, lowest to highest. Keep in step with EFFORT_LEVELS in @repo/llm. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type TextEffort = (typeof EFFORT_LEVELS)[number];
export type ModelKind = "text" | "image";
/** Which API a model is called through. */
export type ModelRoute = "openrouter" | "openai" | "anthropic";

export const ROUTE_ORDER: ModelRoute[] = ["openrouter", "openai", "anthropic"];

export const ROUTE_LABELS: Record<ModelRoute, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
};

/**
 * Vendor order inside the OpenRouter group: the original five, then the
 * three most-used authors on OpenRouter that were missing (Z.ai, Qwen,
 * Mistral; OpenRouter rankings, week of 9 Nov 2026).
 */
export const VENDOR_ORDER = ["google", "anthropic", "openai", "x-ai", "deepseek", "z-ai", "qwen", "mistralai"] as const;

export const VENDOR_LABELS: Record<string, string> = {
  google: "Google",
  anthropic: "Anthropic",
  openai: "OpenAI",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
  "z-ai": "Z.ai",
  qwen: "Qwen",
  mistralai: "Mistral",
};

export function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor;
}

export interface CatalogModel {
  /** Route-qualified id: OpenRouter slug, `openai-api/<id>` or `anthropic-api/<id>`. */
  id: string;
  name: string;
  kind: ModelKind;
  provider: ModelRoute;
  /** Model maker: google, anthropic, openai, x-ai, deepseek, z-ai, qwen, mistralai. */
  vendor: string;
  description: string;
  fallbackInput: number;
  fallbackOutput: number;
  /** Accepts a reasoning-effort parameter (drives the effort select). */
  supportsEffort: boolean;
  /** The levels it accepts, lowest first (absent means low/medium/high when supportsEffort). */
  effortLevels?: TextEffort[];
  /** The level it uses when none is sent, when known. */
  defaultEffort?: TextEffort;
  recommended?: boolean;
  /** Exactly one model per kind carries this; enforced by tests. */
  isDefault?: boolean;
}

export const DEFAULT_TEXT_MODEL_ID = "google/gemini-3.1-flash-lite-preview";
export const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3.1-flash-image";

type SnapshotExtra = Partial<Pick<CatalogModel, "recommended" | "isDefault" | "kind" | "effortLevels" | "defaultEffort">>;

const or = (
  vendor: string,
  id: string,
  name: string,
  fallbackInput: number,
  fallbackOutput: number,
  description: string,
  extra: SnapshotExtra = {},
): CatalogModel => {
  const kind = extra.kind ?? "text";
  const effortLevels = kind === "text" ? (extra.effortLevels ?? []) : [];
  return {
    id,
    name,
    kind,
    provider: "openrouter",
    vendor,
    description,
    fallbackInput,
    fallbackOutput,
    supportsEffort: effortLevels.length > 0,
    ...(effortLevels.length > 0 ? { effortLevels } : {}),
    ...(extra.defaultEffort ? { defaultEffort: extra.defaultEffort } : {}),
    ...(extra.recommended ? { recommended: true } : {}),
    ...(extra.isDefault ? { isDefault: true } : {}),
  };
};

const direct = (
  provider: "openai" | "anthropic",
  vendorModel: string,
  name: string,
  fallbackInput: number,
  fallbackOutput: number,
  description: string,
  effortLevels: TextEffort[],
  defaultEffort?: TextEffort,
): CatalogModel => ({
  id: `${provider}-api/${vendorModel}`,
  name,
  kind: "text",
  provider,
  vendor: provider,
  description,
  fallbackInput,
  fallbackOutput,
  supportsEffort: effortLevels.length > 0,
  ...(effortLevels.length > 0 ? { effortLevels } : {}),
  ...(defaultEffort ? { defaultEffort } : {}),
});

/** Group order: OpenRouter text (vendor order), OpenRouter image, OpenAI API, Anthropic API. */
export const MODEL_SNAPSHOT: CatalogModel[] = [
  // OpenRouter, google
  or("google", DEFAULT_TEXT_MODEL_ID, "Gemini 3.1 Flash Lite", 0.25, 1.5, "Pipeline default. Fast and very cheap; solid site copy.", { effortLevels: ["none", "minimal", "low", "medium", "high"], defaultEffort: "minimal", isDefault: true }),
  or("google", "google/gemini-4-carbon", "Gemini 4 Carbon", 2, 10, "Google's strongest Gemini 4 model, for the hardest briefs.", { effortLevels: ["low", "medium", "high"], defaultEffort: "medium" }),
  or("google", "google/gemini-4-argon", "Gemini 4 Argon", 2, 10, "Gemini 4 frontier quality at a lower cost per turn than Carbon.", { effortLevels: ["low", "medium", "high"], defaultEffort: "medium" }),
  or("google", "google/gemini-4-hydrogen", "Gemini 4 Hydrogen", 1.5, 7.5, "Fast Gemini 4 tier; the step up from 3.8 Flash.", { effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }),
  or("google", "google/gemini-3.8-flash", "Gemini 3.8 Flash", 0.825, 4.125, "Latest Gemini 3 Flash; cheaper than Hydrogen.", { effortLevels: ["low", "medium", "high"], defaultEffort: "medium" }),
  or("google", "google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 0.3, 2.5, "Latest Flash Lite tier.", { effortLevels: ["minimal", "low", "medium", "high"], defaultEffort: "minimal" }),
  // OpenRouter, anthropic
  or("anthropic", "anthropic/claude-fable-5.2", "Claude Fable 5.2", 8, 40, "Anthropic's top tier.", { effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" }),
  or("anthropic", "anthropic/claude-opus-5.5", "Claude Opus 5.5", 4, 20, "Premium Claude for flagship shops.", { effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" }),
  or("anthropic", "anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", 2, 10, "Best copy quality for the price. Recommended for client-facing sites.", { effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", recommended: true }),
  or("anthropic", "anthropic/claude-haiku-5.5", "Claude Haiku 5.5", 0.1, 0.5, "Fast, very cheap Claude; good copy on a budget.", { effortLevels: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }),
  // OpenRouter, openai
  or("openai", "openai/gpt-6-astra", "GPT-6 Astra", 10, 50, "OpenAI's top tier.", { effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }),
  or("openai", "openai/gpt-6.1-sol", "GPT-6.1 Sol", 2, 10, "OpenAI's premium creative tier.", { effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }),
  or("openai", "openai/gpt-6.1-terra", "GPT-6.1 Terra", 1, 5, "Strong creative writing at a mid-range price.", { effortLevels: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }),
  or("openai", "openai/gpt-6-luna", "GPT-6 Luna", 0.1, 0.5, "Budget tier of OpenAI's latest family.", { effortLevels: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }),
  // OpenRouter, x-ai
  or("x-ai", "x-ai/grok-4.7", "Grok 4.7", 2, 6, "Punchy, direct copy. Good price for a frontier model.", { effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "high" }),
  or("x-ai", "x-ai/grok-4.20-multi-agent", "Grok 4.20 Multi-Agent", 1.25, 2.5, "Multi-agent Grok; very cheap for its quality.", { effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }),
  // OpenRouter, deepseek
  or("deepseek", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 0.9, 1.5, "Near-frontier quality at budget pricing.", { effortLevels: ["none", "high", "xhigh"], defaultEffort: "high" }),
  or("deepseek", "deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 0.14, 0.42, "Very cheap DeepSeek tier.", { effortLevels: ["none", "low", "high", "max"], defaultEffort: "high" }),
  // OpenRouter, z-ai
  or("z-ai", "z-ai/glm-5.3-prime", "GLM 5.3 Prime", 1.68, 5.28, "Z.ai's top GLM tier.", { effortLevels: ["low", "high", "max"], defaultEffort: "max" }),
  or("z-ai", "z-ai/glm-5.3", "GLM 5.3", 0.07, 1.4, "Z.ai's standard GLM; very cheap input.", { effortLevels: ["low", "high", "max"], defaultEffort: "max" }),
  or("z-ai", "z-ai/glm-5.3-flash", "GLM 5.3 Flash", 0.04, 0.078, "The cheapest text model in the catalogue.", { effortLevels: ["low", "high", "max"], defaultEffort: "max" }),
  // OpenRouter, qwen
  or("qwen", "qwen/qwen4-max", "Qwen4 Max", 1.425, 4.275, "Alibaba's flagship Qwen model.", { effortLevels: ["none", "low", "high", "xhigh"], defaultEffort: "high" }),
  or("qwen", "qwen/qwen3.7-plus", "Qwen3.7 Plus", 0.32, 1.28, "Mid-range Qwen. No effort control.", { effortLevels: [] }),
  or("qwen", "qwen/qwen3.8-flash", "Qwen3.8 Flash", 0.15, 0.47, "Fast, cheap Qwen. No effort control.", { effortLevels: [] }),
  // OpenRouter, mistralai
  or("mistralai", "mistralai/mistral-large-4-0", "Mistral Large 4", 0.7, 2.1, "Mistral's flagship, from an EU-based vendor.", { effortLevels: ["none", "high"], defaultEffort: "high" }),
  or("mistralai", "mistralai/mistral-medium-3-5", "Mistral Medium 3.5", 1.5, 7.5, "Mid-range Mistral.", { effortLevels: ["none", "high"], defaultEffort: "high" }),
  // OpenRouter image (curated, unchanged)
  or("google", DEFAULT_IMAGE_MODEL_ID, "Gemini 3.1 Flash Image", 0.5, 3, "Pipeline default (Nano Banana 2).", { kind: "image", isDefault: true }),
  or("google", "google/gemini-3.1-flash-lite-image", "Gemini 3.1 Flash Lite Image", 0.25, 1.5, "Cheapest image tier.", { kind: "image" }),
  or("google", "google/gemini-3-pro-image", "Gemini 3 Pro Image", 2, 12, "Highest-fidelity Google image model.", { kind: "image" }),
  or("openai", "openai/gpt-5-image-mini", "GPT-5 Image Mini", 2.5, 2, "OpenAI budget image model.", { kind: "image" }),
  or("openai", "openai/gpt-5.4-image-2", "GPT-5.4 Image 2", 8, 15, "OpenAI's premium image model.", { kind: "image" }),
  // OpenAI API (direct)
  direct("openai", "gpt-6-astra", "GPT-6 Astra", 10, 50, "OpenAI's top tier, called directly.", ["low", "medium", "high", "xhigh", "max"], "medium"),
  direct("openai", "gpt-6.1-sol", "GPT-6.1 Sol", 2, 10, "OpenAI's premium creative tier, called directly.", ["low", "medium", "high", "xhigh", "max"], "medium"),
  direct("openai", "gpt-6.1-terra", "GPT-6.1 Terra", 1, 5, "Strong creative writing, called directly.", ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
  direct("openai", "gpt-6-luna", "GPT-6 Luna", 0.1, 0.5, "OpenAI's budget tier, called directly.", ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
  // Anthropic API (direct)
  direct("anthropic", "claude-fable-5-2", "Claude Fable 5.2", 8, 40, "Anthropic's top tier, called directly.", ["low", "medium", "high", "xhigh", "max"]),
  direct("anthropic", "claude-opus-5-5", "Claude Opus 5.5", 4, 20, "Premium Claude, called directly.", ["low", "medium", "high", "xhigh", "max"]),
  direct("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10, "Best copy quality for the price, called directly.", ["low", "medium", "high", "xhigh", "max"]),
  direct("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5, "Fast, very cheap Claude, called directly.", ["low", "medium", "high", "xhigh", "max"]),
];

export interface CatalogModelWithProvider extends CatalogModel {
  providerLabel: string;
  vendorLabel: string;
}

/** Flatten the snapshot, optionally filtered by kind, preserving order. */
export function catalogModels(kind?: ModelKind): CatalogModelWithProvider[] {
  const out: CatalogModelWithProvider[] = [];
  for (const m of MODEL_SNAPSHOT) {
    if (kind && m.kind !== kind) continue;
    out.push({ ...m, providerLabel: ROUTE_LABELS[m.provider], vendorLabel: vendorLabel(m.vendor) });
  }
  return out;
}

/** Resolve a snapshot id; when `kind` is given, a wrong-kind match is undefined. */
export function findCatalogModel(id: string, kind?: ModelKind): CatalogModelWithProvider | undefined {
  return catalogModels(kind).find((m) => m.id === id);
}

/** Fallback USD-per-1M prices for an id the snapshot knows; undefined otherwise. */
export function fallbackPriceFor(id: string): { input: number; output: number } | undefined {
  const m = MODEL_SNAPSHOT.find((x) => x.id === id);
  return m ? { input: m.fallbackInput, output: m.fallbackOutput } : undefined;
}
