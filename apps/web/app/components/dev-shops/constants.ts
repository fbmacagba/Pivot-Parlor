// Constants for the developer "Shops" dashboard (dev.shops route).
// Extracted from dev.shops.tsx (T7.7) — no behavior change.
import type { Shop } from "./types";

export const DEFAULT_TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";

/** Top-10 OpenRouter providers, one flagship each. Pricing snapshot 2026-07-10;
 *  the live-priced list is served by /api/ai/models (AI Deploy page). Keep this
 *  in sync with CURATED_MODELS in apps/worker/src/services/model-registry.ts. */
export const TEXT_MODEL_OPTIONS: { value: string; label: string; supportsEffort?: boolean }[] = [
  {
    value: "google/gemini-3.1-flash-lite-preview",
    label: "Google | Gemini 3.1 Flash Lite — $0.25/1M in · $1.50/1M out (default)",
    supportsEffort: true,
  },
  {
    value: "anthropic/claude-sonnet-5",
    label: "Anthropic | Claude Sonnet 5 — $2.00/1M in · $10.00/1M out ★",
    supportsEffort: true,
  },
  {
    value: "openai/gpt-5.6-terra",
    label: "OpenAI | GPT-5.6 Terra — $2.50/1M in · $15.00/1M out",
    supportsEffort: true,
  },
  {
    value: "x-ai/grok-4.5",
    label: "xAI | Grok 4.5 — $2.00/1M in · $6.00/1M out",
    supportsEffort: true,
  },
  {
    value: "deepseek/deepseek-v4-pro",
    label: "DeepSeek | DeepSeek V4 Pro — $0.44/1M in · $0.87/1M out",
    supportsEffort: true,
  },
  {
    value: "meta-llama/llama-4-maverick",
    label: "Meta | Llama 4 Maverick — $0.15/1M in · $0.60/1M out",
    supportsEffort: false,
  },
  {
    value: "mistralai/mistral-medium-3-5",
    label: "Mistral | Mistral Medium 3.5 — $1.50/1M in · $7.50/1M out",
    supportsEffort: true,
  },
  {
    value: "qwen/qwen3.7-max",
    label: "Qwen | Qwen 3.7 Max — $1.25/1M in · $3.75/1M out",
    supportsEffort: true,
  },
  {
    value: "moonshotai/kimi-k2.6",
    label: "Moonshot | Kimi K2.6 — $0.66/1M in · $3.41/1M out",
    supportsEffort: true,
  },
  {
    value: "z-ai/glm-5.2",
    label: "Z.AI | GLM 5.2 — $0.42/1M in · $1.32/1M out",
    supportsEffort: true,
  },
];

/** Reasoning-effort choices for models that support the OpenRouter reasoning param. */
export const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Default (model decides)" },
  { value: "low", label: "Low — fastest, cheapest" },
  { value: "medium", label: "Medium — balanced" },
  { value: "high", label: "High — deepest thinking, most tokens" },
];

export const IMAGE_MODEL_OPTIONS: { value: string; label: string }[] = [
  {
    value: "google/gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image (Nano Banana 2) — $0.50/1M in · $3.00/1M out (default)",
  },
  {
    value: "google/gemini-2.5-flash-preview:thinking",
    label: "Gemini 2.5 Flash Image (Nano Banana) — $0.50/1M in · $3.00/1M out",
  },
  {
    value: "black-forest-labs/flux-1.1-pro",
    label: "FLUX 1.1 Pro — ~$0.04/image",
  },
  {
    value: "black-forest-labs/flux-schnell",
    label: "FLUX Schnell — FREE",
  },
];

export const REGEN_STEP_LABELS = [
  "Researching brand & style",
  "Generating website content",
  "Creating hero background image",
  "Creating shop logo",
  "Creating service images",
  "Assembling website",
  "Complete",
] as const;

/** SSR-only mock for Playwright (page.route cannot intercept loader fetches to API_URL). */
export const E2E_STRIPE_LIST_SHOPS: Shop[] = [
  {
    id: "e2e-mock-unpaid",
    shop_number: 999,
    name: "E2E Unpaid Shop",
    slug: "e2e-unpaid-999",
    type: "beauty_parlor",
    owner_name: "",
    owner_email: "e2e@example.com",
    is_active: 0,
    status: "awaiting_payment",
    plan: "standard",
    has_site: null,
    stripe_payment_status: "unpaid",
    stripe_checkout_url: "https://checkout.stripe.com/e2e-mock-session",
  },
];
