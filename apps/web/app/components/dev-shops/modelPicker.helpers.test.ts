import { describe, it, expect } from "vitest";
import {
  defaultModelForGroup,
  effortLevelsFor,
  groupByRoute,
  groupByVendor,
  modelPriceLabel,
  type PickerModel,
} from "./modelPicker.helpers";

const m = (
  id: string,
  provider: string,
  providerLabel: string,
  vendor: string,
  vendorLabel: string,
  extra: Partial<PickerModel> = {},
): PickerModel => ({
  id,
  name: id,
  provider,
  providerLabel,
  vendor,
  vendorLabel,
  costPer1MInput: 2,
  costPer1MOutput: 10,
  supportsEffort: true,
  ...extra,
});

const MODELS: PickerModel[] = [
  m("google/a", "openrouter", "OpenRouter", "google", "Google"),
  m("anthropic/x", "openrouter", "OpenRouter", "anthropic", "Anthropic", { recommended: true }),
  m("google/b", "openrouter", "OpenRouter", "google", "Google"),
  m("openai-api/p", "openai", "OpenAI API", "openai", "OpenAI"),
  m("anthropic-api/q", "anthropic", "Anthropic API", "anthropic", "Anthropic", { effortLevels: ["medium", "high"] }),
];

describe("groupByRoute", () => {
  it("groups by route in first-seen order with vendor sub-groups in first-seen order", () => {
    const routes = groupByRoute(MODELS);
    expect(routes.map((r) => r.id)).toEqual(["openrouter", "openai", "anthropic"]);
    expect(routes[0]!.label).toBe("OpenRouter");
    expect(routes[0]!.vendors.map((v) => v.id)).toEqual(["google", "anthropic"]);
    expect(routes[0]!.vendors[0]!.models.map((x) => x.id)).toEqual(["google/a", "google/b"]);
    expect(routes[1]!.vendors.map((v) => v.label)).toEqual(["OpenAI"]);
  });
});

describe("groupByVendor", () => {
  it("keeps model order inside each vendor", () => {
    const groups = groupByVendor(MODELS.filter((x) => x.provider === "openrouter"));
    expect(groups.map((g) => g.id)).toEqual(["google", "anthropic"]);
    expect(groups[0]!.models.map((x) => x.id)).toEqual(["google/a", "google/b"]);
  });
});

describe("defaultModelForGroup", () => {
  it("prefers the recommended model, else the first", () => {
    const routes = groupByRoute(MODELS);
    expect(defaultModelForGroup(routes[0]!)?.id).toBe("anthropic/x");
    expect(defaultModelForGroup(routes[1]!)?.id).toBe("openai-api/p");
    expect(defaultModelForGroup({ id: "empty", label: "Empty", models: [] })).toBeUndefined();
  });
});

describe("effortLevelsFor", () => {
  it("returns the reported subset, all three when unreported, none when unsupported or absent", () => {
    expect(effortLevelsFor(MODELS[4])).toEqual(["medium", "high"]);
    expect(effortLevelsFor(MODELS[0])).toEqual(["low", "medium", "high"]);
    expect(effortLevelsFor(m("z", "openrouter", "OpenRouter", "google", "Google", { supportsEffort: false }))).toEqual([]);
    expect(effortLevelsFor(m("z", "openrouter", "OpenRouter", "google", "Google", { effortLevels: [] }))).toEqual([]);
    expect(effortLevelsFor(undefined)).toEqual([]);
  });
});

describe("modelPriceLabel", () => {
  it("formats per-1M pricing", () => {
    expect(modelPriceLabel(m("a/b", "openrouter", "OpenRouter", "a", "A"))).toBe("$2/1M in · $10/1M out");
  });

  it("says so when nobody could price the model", () => {
    expect(
      modelPriceLabel(m("a/b", "openrouter", "OpenRouter", "a", "A", { costPer1MInput: 0, costPer1MOutput: 0, livePricing: false })),
    ).toBe("price unavailable");
    expect(
      modelPriceLabel(m("a/b", "openrouter", "OpenRouter", "a", "A", { costPer1MInput: 0, costPer1MOutput: 0, livePricing: true })),
    ).toBe("$0/1M in · $0/1M out");
  });
});
