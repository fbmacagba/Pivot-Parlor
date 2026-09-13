import { describe, it, expect } from "vitest";
import type { AIModel } from "@repo/types";
import { pickerModelsFrom, staticPickerModels } from "./constants";

const live: AIModel = {
  id: "openai-api/gpt-6-astra",
  name: "GPT-6 Astra",
  kind: "text",
  provider: "openai",
  providerLabel: "OpenAI API",
  vendor: "openai",
  vendorLabel: "OpenAI",
  description: "",
  costPer1MInput: 10,
  costPer1MOutput: 50,
  supportsEffort: true,
  effortLevels: ["low", "medium", "high"],
  recommended: false,
  livePricing: true,
};

describe("pickerModelsFrom", () => {
  it("uses the live list filtered by kind when it has entries of that kind", () => {
    const out = pickerModelsFrom([live, { ...live, id: "google/gemini-3.1-flash-image", kind: "image" }], "text");
    expect(out.map((m) => m.id)).toEqual(["openai-api/gpt-6-astra"]);
    expect(out[0]!.livePricing).toBe(true);
  });

  it("falls back to the snapshot when the live list is missing, empty or lacks that kind", () => {
    const snapshotText = staticPickerModels("text").map((m) => m.id);
    expect(pickerModelsFrom(null, "text").map((m) => m.id)).toEqual(snapshotText);
    expect(pickerModelsFrom([], "text").map((m) => m.id)).toEqual(snapshotText);
    expect(pickerModelsFrom([live], "image").map((m) => m.id)).toEqual(staticPickerModels("image").map((m) => m.id));
    expect(pickerModelsFrom(null, "text").every((m) => m.livePricing === false)).toBe(true);
  });
});
