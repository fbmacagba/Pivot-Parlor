import { describe, it, expect } from "vitest";
import {
  MODEL_CATALOG,
  catalogModels,
  findCatalogModel,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
} from "@repo/utils";

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
