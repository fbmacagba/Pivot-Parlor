/**
 * Reasoning effort, lowest to highest. The vendors accept different subsets:
 * OpenRouter takes all seven and maps a level a model lacks to its nearest;
 * OpenAI's chat completions take the subset each model supports (GPT-6 Astra
 * and GPT-6.1 Sol reject "none"); Anthropic's Messages API takes low to max.
 * The model registry records each model's subset, so pickers only offer
 * levels the model accepts. Keep in step with EFFORT_LEVELS in @repo/utils.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

/** A known level, or undefined for anything else (including ""). */
export function parseEffort(v: unknown): Effort | undefined {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as Effort) : undefined;
}

/** The known levels in `levels`, deduplicated and in ladder order. */
export function orderEfforts(levels: readonly unknown[]): Effort[] {
  return EFFORT_LEVELS.filter((level) => levels.includes(level));
}

/**
 * Output budget for a JSON-producing call. Reasoning tokens count against the
 * output limit on every route, so a higher level needs room to think and
 * still finish the JSON. Pass the level that will actually apply: the chosen
 * one, or the model's own default when none is chosen. Estimated from the
 * vendors' docs, not measured.
 */
export function outputBudgetForEffort(effort: Effort | undefined, base: number): number {
  if (effort === "xhigh") return Math.max(base, 12_288);
  if (effort === "max") return Math.max(base, 16_000);
  return base;
}
