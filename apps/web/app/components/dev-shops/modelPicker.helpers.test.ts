import { describe, it, expect } from "vitest";
import { groupByProvider, modelPriceLabel, type PickerModel } from "./modelPicker.helpers";

const m = (id: string, provider: string, providerLabel: string): PickerModel => ({
  id,
  name: id,
  provider,
  providerLabel,
  costPer1MInput: 2,
  costPer1MOutput: 10,
  supportsEffort: true,
});

describe("groupByProvider", () => {
  it("groups in first-seen provider order and keeps model order", () => {
    const groups = groupByProvider([
      m("google/a", "google", "Google"),
      m("anthropic/x", "anthropic", "Anthropic"),
      m("google/b", "google", "Google"),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["google", "anthropic"]);
    expect(groups[0]!.models.map((x) => x.id)).toEqual(["google/a", "google/b"]);
    expect(groups[0]!.label).toBe("Google");
  });
});

describe("modelPriceLabel", () => {
  it("formats per-1M pricing", () => {
    expect(modelPriceLabel(m("a/b", "a", "A"))).toBe("$2/1M in · $10/1M out");
  });
});
