/**
 * Cascaded OpenRouter model catalogue — single source of truth for WHICH
 * models the AI tools offer (top 5 providers, 2-3 tiers each), consumed by
 * the worker registry (validation + live-priced /api/ai/models) and the web
 * pickers. Kept deliberately small so a developer can pick at a glance and
 * so the endpoints cannot be used as a proxy to arbitrary expensive models.
 *
 * fallbackInput/fallbackOutput are USD per 1M tokens, snapshot 2026-07-19
 * from the public OpenRouter catalogue; live pricing overrides them at read
 * time in the worker registry. Image mode lists only providers that actually
 * have an image model on OpenRouter (Google, OpenAI; xAI has none).
 */

export type TextEffort = "low" | "medium" | "high";
export type ModelKind = "text" | "image";

export interface CatalogModel {
  id: string;
  name: string;
  kind: ModelKind;
  description: string;
  fallbackInput: number;
  fallbackOutput: number;
  /** Supports the OpenRouter `reasoning` param (drives the effort select). */
  supportsEffort: boolean;
  recommended?: boolean;
  /** Exactly one model per kind carries this; enforced by tests. */
  isDefault?: boolean;
}

export interface CatalogProvider {
  id: string;
  label: string;
  models: CatalogModel[];
}

export const MODEL_CATALOG: CatalogProvider[] = [
  {
    id: "google",
    label: "Google",
    models: [
      {
        id: "google/gemini-3.1-flash-lite-preview",
        name: "Gemini 3.1 Flash Lite",
        kind: "text",
        description: "Pipeline default. Fast and very cheap; solid site copy.",
        fallbackInput: 0.25,
        fallbackOutput: 1.5,
        supportsEffort: true,
        isDefault: true,
      },
      {
        id: "google/gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        kind: "text",
        description: "Latest Flash tier; sharper copy than Lite.",
        fallbackInput: 1.5,
        fallbackOutput: 9.0,
        supportsEffort: true,
      },
      {
        id: "google/gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro",
        kind: "text",
        description: "Google's flagship; strongest layout sense.",
        fallbackInput: 2.0,
        fallbackOutput: 12.0,
        supportsEffort: true,
      },
      {
        id: "google/gemini-3.1-flash-image-preview",
        name: "Gemini 3.1 Flash Image",
        kind: "image",
        description: "Pipeline default (Nano Banana 2).",
        fallbackInput: 0.5,
        fallbackOutput: 3.0,
        supportsEffort: false,
        isDefault: true,
      },
      {
        id: "google/gemini-3.1-flash-lite-image",
        name: "Gemini 3.1 Flash Lite Image",
        kind: "image",
        description: "Cheapest image tier.",
        fallbackInput: 0.25,
        fallbackOutput: 1.5,
        supportsEffort: false,
      },
      {
        id: "google/gemini-3-pro-image",
        name: "Gemini 3 Pro Image",
        kind: "image",
        description: "Highest-fidelity Google image model.",
        fallbackInput: 2.0,
        fallbackOutput: 12.0,
        supportsEffort: false,
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: [
      {
        id: "anthropic/claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        kind: "text",
        description: "Fast Claude; good copy on a budget.",
        fallbackInput: 1.0,
        fallbackOutput: 5.0,
        supportsEffort: true,
      },
      {
        id: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        kind: "text",
        description: "Best copy quality for the price. Recommended for client-facing sites.",
        fallbackInput: 2.0,
        fallbackOutput: 10.0,
        supportsEffort: true,
        recommended: true,
      },
      {
        id: "anthropic/claude-opus-4.8",
        name: "Claude Opus 4.8",
        kind: "text",
        description: "Premium Claude for flagship shops.",
        fallbackInput: 5.0,
        fallbackOutput: 25.0,
        supportsEffort: true,
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: [
      {
        id: "openai/gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        kind: "text",
        description: "Budget tier of OpenAI's latest family.",
        fallbackInput: 1.0,
        fallbackOutput: 6.0,
        supportsEffort: true,
      },
      {
        id: "openai/gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        kind: "text",
        description: "Strong creative writing and layout sense.",
        fallbackInput: 2.5,
        fallbackOutput: 15.0,
        supportsEffort: true,
      },
      {
        id: "openai/gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        kind: "text",
        description: "OpenAI's premium creative tier.",
        fallbackInput: 5.0,
        fallbackOutput: 30.0,
        supportsEffort: true,
      },
      {
        id: "openai/gpt-5-image-mini",
        name: "GPT-5 Image Mini",
        kind: "image",
        description: "OpenAI budget image model.",
        fallbackInput: 2.5,
        fallbackOutput: 2.0,
        supportsEffort: false,
      },
      {
        id: "openai/gpt-5.4-image-2",
        name: "GPT-5.4 Image 2",
        kind: "image",
        description: "OpenAI's premium image model.",
        fallbackInput: 8.0,
        fallbackOutput: 15.0,
        supportsEffort: false,
      },
    ],
  },
  {
    id: "x-ai",
    label: "xAI",
    models: [
      {
        id: "x-ai/grok-4.3",
        name: "Grok 4.3",
        kind: "text",
        description: "Previous Grok; very cheap for its quality.",
        fallbackInput: 1.25,
        fallbackOutput: 2.5,
        supportsEffort: true,
      },
      {
        id: "x-ai/grok-4.5",
        name: "Grok 4.5",
        kind: "text",
        description: "Punchy, direct copy. Good price for a frontier model.",
        fallbackInput: 2.0,
        fallbackOutput: 6.0,
        supportsEffort: true,
      },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: [
      {
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        kind: "text",
        description: "Cheapest capable model in the catalogue.",
        fallbackInput: 0.098,
        fallbackOutput: 0.196,
        supportsEffort: true,
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        kind: "text",
        description: "Near-frontier quality at budget pricing.",
        fallbackInput: 0.435,
        fallbackOutput: 0.87,
        supportsEffort: true,
      },
    ],
  },
];

export interface CatalogModelWithProvider extends CatalogModel {
  provider: string;
  providerLabel: string;
}

/** Flatten the catalogue, optionally filtered by kind, preserving order. */
export function catalogModels(kind?: ModelKind): CatalogModelWithProvider[] {
  const out: CatalogModelWithProvider[] = [];
  for (const p of MODEL_CATALOG) {
    for (const m of p.models) {
      if (kind && m.kind !== kind) continue;
      out.push({ ...m, provider: p.id, providerLabel: p.label });
    }
  }
  return out;
}

/** Resolve a model id; when `kind` is given, a wrong-kind match is undefined. */
export function findCatalogModel(
  id: string,
  kind?: ModelKind,
): CatalogModelWithProvider | undefined {
  return catalogModels(kind).find((m) => m.id === id);
}

export const DEFAULT_TEXT_MODEL_ID = "google/gemini-3.1-flash-lite-preview";
export const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3.1-flash-image-preview";
