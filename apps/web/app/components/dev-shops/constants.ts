// Constants for the developer "Shops" dashboard (dev.shops route).
// Extracted from dev.shops.tsx (T7.7) — no behavior change.
import {
  catalogModels,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  type ModelKind,
} from "@repo/utils";
import type { AIModel } from "@repo/types";
import type { PickerModel } from "./modelPicker.helpers";

export const DEFAULT_TEXT_MODEL = DEFAULT_TEXT_MODEL_ID;
export const DEFAULT_IMAGE_MODEL = DEFAULT_IMAGE_MODEL_ID;

/** Snapshot entries with fallback pricing, for pickers without a live-priced loader. */
export function staticPickerModels(kind: ModelKind): PickerModel[] {
  return catalogModels(kind).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    providerLabel: m.providerLabel,
    vendor: m.vendor,
    vendorLabel: m.vendorLabel,
    costPer1MInput: m.fallbackInput,
    costPer1MOutput: m.fallbackOutput,
    supportsEffort: m.supportsEffort,
    effortLevels: m.supportsEffort ? (m.effortLevels ?? ["low", "medium", "high"]) : [],
    defaultEffort: m.defaultEffort ?? null,
    recommended: m.recommended,
    livePricing: false,
  }));
}

/** Live registry entries of one kind, else the snapshot (API unreachable or empty). */
export function pickerModelsFrom(live: AIModel[] | null | undefined, kind: ModelKind): PickerModel[] {
  const fromLive = (live ?? []).filter((m) => m.kind === kind);
  return fromLive.length > 0 ? fromLive : staticPickerModels(kind);
}

/** Reasoning-effort choices, lowest first; the picker shows only the levels a model reports. */
export const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Default (model decides)" },
  { value: "none", label: "None - no reasoning, fastest" },
  { value: "minimal", label: "Minimal - a brief think" },
  { value: "low", label: "Low - quick and cheap" },
  { value: "medium", label: "Medium - balanced" },
  { value: "high", label: "High - deeper thinking, more tokens" },
  { value: "xhigh", label: "Extra high - slower, many more tokens" },
  { value: "max", label: "Max - slowest and most expensive" },
];

const EFFORT_NAMES: Record<string, string> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra high",
  max: "max",
};

/** The "Default" option's label, naming the model's own level when the vendor reports it. */
export function defaultEffortLabel(defaultEffort: string | null | undefined): string {
  const name = defaultEffort ? EFFORT_NAMES[defaultEffort] : undefined;
  return name ? `Default (model decides: ${name})` : "Default (model decides)";
}

export const REGEN_STEP_LABELS = [
  "Researching brand & style",
  "Generating website content",
  "Creating hero background image",
  "Creating shop logo",
  "Creating service images",
  "Assembling website",
  "Complete",
] as const;
