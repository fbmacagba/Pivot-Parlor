/**
 * Model snapshot: the last-resort fallback and fallback price table for the
 * live model registry (apps/worker/src/services/model-registry.ts), and the
 * offline list the web pickers use when the API is unreachable.
 *
 * The registry discovers the lists live and ranks them by rule; this file
 * only has to be a faithful picture of what the rules produced when it was
 * recorded. Prices are USD per 1M tokens, recorded 2026-09-12 from the public
 * OpenRouter feed (direct ids priced through their OpenRouter twin). The
 * worker test `model-registry.test.ts` checks every price here against the
 * recorded feed fixture, so refresh both together.
 */

export type TextEffort = "low" | "medium" | "high";
export type ModelKind = "text" | "image";
/** Which API a model is called through. */
export type ModelRoute = "openrouter" | "openai" | "anthropic";

export const ROUTE_ORDER: ModelRoute[] = ["openrouter", "openai", "anthropic"];

export const ROUTE_LABELS: Record<ModelRoute, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
};

/** Vendor order inside the OpenRouter group (unchanged from the old catalogue). */
export const VENDOR_ORDER = ["google", "anthropic", "openai", "x-ai", "deepseek"] as const;

export const VENDOR_LABELS: Record<string, string> = {
  google: "Google",
  anthropic: "Anthropic",
  openai: "OpenAI",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
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
  /** Model maker: google, anthropic, openai, x-ai, deepseek. */
  vendor: string;
  description: string;
  fallbackInput: number;
  fallbackOutput: number;
  /** Accepts a reasoning-effort parameter (drives the effort select). */
  supportsEffort: boolean;
  recommended?: boolean;
  /** Exactly one model per kind carries this; enforced by tests. */
  isDefault?: boolean;
}

export const DEFAULT_TEXT_MODEL_ID = "google/gemini-3.1-flash-lite-preview";
export const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3.1-flash-image";

const or = (
  vendor: string,
  id: string,
  name: string,
  fallbackInput: number,
  fallbackOutput: number,
  description: string,
  extra: Partial<Pick<CatalogModel, "recommended" | "isDefault" | "supportsEffort" | "kind">> = {},
): CatalogModel => ({
  id,
  name,
  kind: extra.kind ?? "text",
  provider: "openrouter",
  vendor,
  description,
  fallbackInput,
  fallbackOutput,
  supportsEffort: extra.supportsEffort ?? (extra.kind ?? "text") === "text",
  ...(extra.recommended ? { recommended: true } : {}),
  ...(extra.isDefault ? { isDefault: true } : {}),
});

const direct = (
  provider: "openai" | "anthropic",
  vendorModel: string,
  name: string,
  fallbackInput: number,
  fallbackOutput: number,
  description: string,
): CatalogModel => ({
  id: `${provider}-api/${vendorModel}`,
  name,
  kind: "text",
  provider,
  vendor: provider,
  description,
  fallbackInput,
  fallbackOutput,
  supportsEffort: true,
});

/** Group order: OpenRouter text (vendor order), OpenRouter image, OpenAI API, Anthropic API. */
export const MODEL_SNAPSHOT: CatalogModel[] = [
  // OpenRouter, google
  or("google", DEFAULT_TEXT_MODEL_ID, "Gemini 3.1 Flash Lite", 0.25, 1.5, "Pipeline default. Fast and very cheap; solid site copy.", { isDefault: true }),
  or("google", "google/gemini-3.1-pro-preview", "Gemini 3.1 Pro", 2, 12, "Google's flagship; strongest layout sense."),
  or("google", "google/gemini-3.8-flash", "Gemini 3.8 Flash", 0.75, 3.75, "Latest Flash tier; sharper copy than Lite."),
  or("google", "google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 0.3, 2.5, "Latest Flash Lite tier."),
  // OpenRouter, anthropic
  or("anthropic", "anthropic/claude-fable-5.1", "Claude Fable 5.1", 10, 50, "Anthropic's top tier."),
  or("anthropic", "anthropic/claude-opus-5", "Claude Opus 5", 5, 25, "Premium Claude for flagship shops."),
  or("anthropic", "anthropic/claude-sonnet-5", "Claude Sonnet 5", 2, 10, "Best copy quality for the price. Recommended for client-facing sites.", { recommended: true }),
  or("anthropic", "anthropic/claude-haiku-4.5", "Claude Haiku 4.5", 1, 5, "Fast Claude; good copy on a budget."),
  // OpenRouter, openai
  or("openai", "openai/gpt-6-astra", "GPT-6 Astra", 10, 50, "OpenAI's top tier."),
  or("openai", "openai/gpt-5.6-sol", "GPT-5.6 Sol", 2, 10, "OpenAI's premium creative tier."),
  or("openai", "openai/gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, "Strong creative writing and layout sense."),
  or("openai", "openai/gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, "Budget tier of OpenAI's latest family."),
  // OpenRouter, x-ai
  or("x-ai", "x-ai/grok-4.6", "Grok 4.6", 2, 6, "Punchy, direct copy. Good price for a frontier model."),
  or("x-ai", "x-ai/grok-4.20-multi-agent", "Grok 4.20 Multi-Agent", 1.25, 2.5, "Multi-agent Grok; very cheap for its quality."),
  // OpenRouter, deepseek
  or("deepseek", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 0.85, 1.7, "Near-frontier quality at budget pricing."),
  or("deepseek", "deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 0.15, 0.6, "Cheapest capable model in the catalogue."),
  // OpenRouter image (curated, unchanged)
  or("google", DEFAULT_IMAGE_MODEL_ID, "Gemini 3.1 Flash Image", 0.5, 3, "Pipeline default (Nano Banana 2).", { kind: "image", isDefault: true }),
  or("google", "google/gemini-3.1-flash-lite-image", "Gemini 3.1 Flash Lite Image", 0.25, 1.5, "Cheapest image tier.", { kind: "image" }),
  or("google", "google/gemini-3-pro-image", "Gemini 3 Pro Image", 2, 12, "Highest-fidelity Google image model.", { kind: "image" }),
  or("openai", "openai/gpt-5-image-mini", "GPT-5 Image Mini", 2.5, 2, "OpenAI budget image model.", { kind: "image" }),
  or("openai", "openai/gpt-5.4-image-2", "GPT-5.4 Image 2", 8, 15, "OpenAI's premium image model.", { kind: "image" }),
  // OpenAI API (direct)
  direct("openai", "gpt-6-astra", "GPT-6 Astra", 10, 50, "OpenAI's top tier, called directly."),
  direct("openai", "gpt-5.6-sol", "GPT-5.6 Sol", 2, 10, "OpenAI's premium creative tier, called directly."),
  direct("openai", "gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, "Strong creative writing, called directly."),
  direct("openai", "gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, "OpenAI's budget tier, called directly."),
  // Anthropic API (direct)
  direct("anthropic", "claude-fable-5.1", "Claude Fable 5.1", 10, 50, "Anthropic's top tier, called directly."),
  direct("anthropic", "claude-opus-5", "Claude Opus 5", 5, 25, "Premium Claude, called directly."),
  direct("anthropic", "claude-sonnet-5", "Claude Sonnet 5", 2, 10, "Best copy quality for the price, called directly."),
  direct("anthropic", "claude-haiku-4.5", "Claude Haiku 4.5", 1, 5, "Fast Claude, called directly."),
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
