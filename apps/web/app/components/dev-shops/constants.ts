// Constants for the developer "Shops" dashboard (dev.shops route).
// Extracted from dev.shops.tsx (T7.7) — no behavior change.
import type { Shop } from "./types";

export const DEFAULT_TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";

export const TEXT_MODEL_OPTIONS: { value: string; label: string }[] = [
  {
    value: "google/gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite — $0.25/1M in · $1.50/1M out (default)",
  },
  {
    value: "google/gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview — $0.50/1M in · $3.00/1M out",
  },
  {
    value: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview — $2.00/1M in · $12.00/1M out",
  },
  {
    value: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5 — $0.80/1M in · $4.00/1M out",
  },
  {
    value: "anthropic/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 — $3.00/1M in · $15.00/1M out",
  },
  {
    value: "meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B — FREE",
  },
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
