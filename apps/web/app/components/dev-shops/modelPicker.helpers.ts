// Pure logic for the cascaded model picker, split from the component so the
// grouping/labelling behaviour is unit-testable without rendering.

export interface PickerModel {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  supportsEffort: boolean;
  recommended?: boolean;
  livePricing?: boolean;
}

export interface PickerGroup {
  id: string;
  label: string;
  models: PickerModel[];
}

/** Group models by provider, preserving first-seen provider and model order. */
export function groupByProvider(models: PickerModel[]): PickerGroup[] {
  const groups: PickerGroup[] = [];
  for (const model of models) {
    let group = groups.find((g) => g.id === model.provider);
    if (!group) {
      group = { id: model.provider, label: model.providerLabel, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

export function modelPriceLabel(m: PickerModel): string {
  return `$${m.costPer1MInput}/1M in · $${m.costPer1MOutput}/1M out`;
}

/** Provider change picks that provider's recommended model, else its first. */
export function defaultModelForProvider(group: PickerGroup): PickerModel | undefined {
  return group.models.find((m) => m.recommended) ?? group.models[0];
}
