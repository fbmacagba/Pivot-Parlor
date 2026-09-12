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
  /** Model maker: google, anthropic, openai, x-ai, deepseek. */
  vendor: string;
  vendorLabel: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  supportsEffort: boolean;
  /** Effort levels the model accepts; absent means "all three" when supportsEffort. */
  effortLevels?: string[];
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

export const ALL_EFFORT_LEVELS = ["low", "medium", "high"];

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

/** Effort levels to offer for a model: the reported subset, all three when unreported, none when unsupported. */
export function effortLevelsFor(m: PickerModel | undefined): string[] {
  if (!m || !m.supportsEffort) return [];
  if (m.effortLevels === undefined) return ALL_EFFORT_LEVELS;
  return m.effortLevels.filter((level) => ALL_EFFORT_LEVELS.includes(level));
}
