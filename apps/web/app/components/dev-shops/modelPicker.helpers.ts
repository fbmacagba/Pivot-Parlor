// Pure logic for the cascaded model picker (Provider -> vendor -> model ->
// effort), split from the component so grouping and labelling are
// unit-testable without rendering. `AIModel` from @repo/types satisfies
// PickerModel structurally; staticPickerModels() builds one from the snapshot.

export interface PickerModel {
  id: string;
  name: string;
  /** Route: "openrouter" | "openai" | "anthropic". */
  provider: string;
  providerLabel: string;
  /** Model maker: google, anthropic, openai, x-ai, deepseek, z-ai, qwen, mistralai. */
  vendor: string;
  vendorLabel: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  supportsEffort: boolean;
  /** Effort levels the model accepts, lowest first; absent means low/medium/high when supportsEffort. */
  effortLevels?: string[];
  /** The level the model uses when none is sent, when the vendor reports it. */
  defaultEffort?: string | null;
  recommended?: boolean;
  livePricing?: boolean;
}

export interface PickerGroup {
  id: string;
  label: string;
  models: PickerModel[];
}

export interface RouteGroup extends PickerGroup {
  vendors: PickerGroup[];
}

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every level, lowest first (matches EFFORT_LEVELS in @repo/utils). */
export const ALL_EFFORT_LEVELS: readonly Effort[] = Object.freeze<Effort[]>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** What a model that reports no levels is offered (the rule before levels were reported). */
const UNREPORTED_LEVELS: readonly Effort[] = Object.freeze<Effort[]>(["low", "medium", "high"]);

function groupBy(models: PickerModel[], key: (m: PickerModel) => { id: string; label: string }): PickerGroup[] {
  const groups: PickerGroup[] = [];
  for (const model of models) {
    const k = key(model);
    let group = groups.find((g) => g.id === k.id);
    if (!group) {
      group = { id: k.id, label: k.label, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/** Group by vendor, preserving first-seen vendor and model order. */
export function groupByVendor(models: PickerModel[]): PickerGroup[] {
  return groupBy(models, (m) => ({ id: m.vendor, label: m.vendorLabel }));
}

/** Group by route (provider) in first-seen order, each with vendor sub-groups. */
export function groupByRoute(models: PickerModel[]): RouteGroup[] {
  return groupBy(models, (m) => ({ id: m.provider, label: m.providerLabel })).map((g) => ({
    ...g,
    vendors: groupByVendor(g.models),
  }));
}

export function modelPriceLabel(m: PickerModel): string {
  if (!m.livePricing && m.costPer1MInput === 0 && m.costPer1MOutput === 0) return "price unavailable";
  return `$${m.costPer1MInput}/1M in · $${m.costPer1MOutput}/1M out`;
}

/** A group change picks the group's recommended model, else its first. */
export function defaultModelForGroup(group: PickerGroup): PickerModel | undefined {
  return group.models.find((m) => m.recommended) ?? group.models[0];
}

/** Effort levels to offer for a model: the reported subset in ladder order, low/medium/high when unreported, none when unsupported. */
export function effortLevelsFor(m: PickerModel | undefined): string[] {
  if (!m || !m.supportsEffort) return [];
  if (m.effortLevels === undefined) return [...UNREPORTED_LEVELS];
  const reported = m.effortLevels;
  return ALL_EFFORT_LEVELS.filter((level) => reported.includes(level));
}

/** The effort to send: the chosen level when this model takes it, else "" (the model decides). */
export function effortToSend(m: PickerModel | undefined, effort: string): string {
  return effort && effortLevelsFor(m).includes(effort) ? effort : "";
}
