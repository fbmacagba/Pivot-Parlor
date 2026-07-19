import { describe, it, expect } from "vitest";
import {
  MODEL_CATALOG,
  catalogModels,
  findCatalogModel,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
} from "@repo/utils";
import { mergeLiveModels, fallbackModels, getModel } from "../src/services/model-registry";

describe("MODEL_CATALOG shape", () => {
  it("carries exactly the top 5 providers in order", () => {
    expect(MODEL_CATALOG.map((p) => p.id)).toEqual([
      "google",
      "anthropic",
      "openai",
      "x-ai",
      "deepseek",
    ]);
  });

  it("has globally unique model ids", () => {
    const ids = catalogModels().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prefixes every model id with its provider id", () => {
    for (const m of catalogModels()) {
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
    }
  });

  it("has exactly one default per kind, matching the exported constants", () => {
    const textDefaults = catalogModels("text").filter((m) => m.isDefault);
    const imageDefaults = catalogModels("image").filter((m) => m.isDefault);
    expect(textDefaults.map((m) => m.id)).toEqual([DEFAULT_TEXT_MODEL_ID]);
    expect(imageDefaults.map((m) => m.id)).toEqual([DEFAULT_IMAGE_MODEL_ID]);
  });

  it("keeps the pipeline defaults unchanged", () => {
    expect(DEFAULT_TEXT_MODEL_ID).toBe("google/gemini-3.1-flash-lite-preview");
    expect(DEFAULT_IMAGE_MODEL_ID).toBe("google/gemini-3.1-flash-image-preview");
  });

  it("offers image models only from providers that have one (google, openai)", () => {
    const providers = new Set(catalogModels("image").map((m) => m.provider));
    expect([...providers].sort()).toEqual(["google", "openai"]);
  });

  it("gives every provider 2-3 text models", () => {
    for (const p of MODEL_CATALOG) {
      const texts = p.models.filter((m) => m.kind === "text");
      expect(texts.length).toBeGreaterThanOrEqual(2);
      expect(texts.length).toBeLessThanOrEqual(3);
    }
  });

  it("marks image models as not supporting effort", () => {
    for (const m of catalogModels("image")) {
      expect(m.supportsEffort).toBe(false);
    }
  });

  it("keeps Claude Sonnet 5 as the recommended text model", () => {
    const rec = catalogModels("text").filter((m) => m.recommended);
    expect(rec.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("findCatalogModel resolves ids and enforces kind", () => {
    expect(findCatalogModel("anthropic/claude-sonnet-5")?.providerLabel).toBe("Anthropic");
    expect(findCatalogModel("anthropic/claude-sonnet-5", "image")).toBeUndefined();
    expect(findCatalogModel("black-forest-labs/flux-schnell")).toBeUndefined();
  });
});

describe("model-registry derives from the shared catalog", () => {
  it("serves all catalog models (text + image) with kind", () => {
    const all = fallbackModels();
    expect(all.length).toBe(catalogModels().length);
    expect(all.find((m) => m.id === "google/gemini-3.1-flash-image-preview")?.kind).toBe("image");
    expect(all.find((m) => m.id === "anthropic/claude-sonnet-5")?.kind).toBe("text");
  });

  it("drops removed legacy models", () => {
    const ids = fallbackModels().map((m) => m.id);
    expect(ids).not.toContain("meta-llama/llama-4-maverick");
    expect(ids).not.toContain("black-forest-labs/flux-schnell");
  });

  it("merges live pricing by id and marks livePricing", () => {
    const merged = mergeLiveModels([
      {
        id: "anthropic/claude-sonnet-5",
        pricing: { prompt: "0.000002", completion: "0.00001" },
        supported_parameters: ["reasoning"],
      },
    ]);
    const sonnet = merged.find((m) => m.id === "anthropic/claude-sonnet-5");
    expect(sonnet?.livePricing).toBe(true);
    expect(sonnet?.costPer1MInput).toBe(2);
    const other = merged.find((m) => m.id === "x-ai/grok-4.5");
    expect(other?.livePricing).toBe(false);
  });

  it("getModel enforces kind when asked", () => {
    expect(getModel("anthropic/claude-sonnet-5", "text")).toBeDefined();
    expect(getModel("anthropic/claude-sonnet-5", "image")).toBeUndefined();
    expect(getModel("google/gemini-3.1-flash-image-preview", "image")).toBeDefined();
  });
});
