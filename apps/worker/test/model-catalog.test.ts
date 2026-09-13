import { describe, it, expect } from "vitest";
import {
  MODEL_SNAPSHOT,
  ROUTE_ORDER,
  VENDOR_ORDER,
  catalogModels,
  findCatalogModel,
  fallbackPriceFor,
  vendorLabel,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
} from "@repo/utils";

describe("MODEL_SNAPSHOT shape", () => {
  it("lists the three routes in picker order and only those", () => {
    const seen = [...new Set(MODEL_SNAPSHOT.map((m) => m.provider))];
    expect(seen).toEqual(ROUTE_ORDER);
  });

  it("has globally unique ids", () => {
    const ids = MODEL_SNAPSHOT.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prefixes ids by route and vendor", () => {
    for (const m of MODEL_SNAPSHOT) {
      if (m.provider === "openrouter") expect(m.id.startsWith(`${m.vendor}/`)).toBe(true);
      else {
        expect(m.id.startsWith(`${m.provider}-api/`)).toBe(true);
        expect(m.vendor).toBe(m.provider);
      }
    }
  });

  it("keeps OpenRouter vendors in catalogue order", () => {
    const vendors = [...new Set(MODEL_SNAPSHOT.filter((m) => m.provider === "openrouter" && m.kind === "text").map((m) => m.vendor))];
    expect(vendors).toEqual([...VENDOR_ORDER]);
  });

  it("has exactly one default per kind, matching the exported constants", () => {
    expect(catalogModels("text").filter((m) => m.isDefault).map((m) => m.id)).toEqual([DEFAULT_TEXT_MODEL_ID]);
    expect(catalogModels("image").filter((m) => m.isDefault).map((m) => m.id)).toEqual([DEFAULT_IMAGE_MODEL_ID]);
  });

  it("keeps the pipeline defaults unchanged", () => {
    expect(DEFAULT_TEXT_MODEL_ID).toBe("google/gemini-3.1-flash-lite-preview");
    expect(DEFAULT_IMAGE_MODEL_ID).toBe("google/gemini-3.1-flash-image");
  });

  it("offers the four direct tiers per vendor", () => {
    expect(MODEL_SNAPSHOT.filter((m) => m.provider === "openai").map((m) => m.id)).toEqual([
      "openai-api/gpt-6-astra",
      "openai-api/gpt-5.6-sol",
      "openai-api/gpt-5.6-terra",
      "openai-api/gpt-5.6-luna",
    ]);
    expect(MODEL_SNAPSHOT.filter((m) => m.provider === "anthropic").map((m) => m.id)).toEqual([
      "anthropic-api/claude-fable-5.1",
      "anthropic-api/claude-opus-5",
      "anthropic-api/claude-sonnet-5",
      "anthropic-api/claude-haiku-4.5",
    ]);
  });

  it("keeps image models on OpenRouter only, from google and openai, without effort", () => {
    const images = catalogModels("image");
    expect(images).toHaveLength(5);
    for (const m of images) {
      expect(m.provider).toBe("openrouter");
      expect(m.supportsEffort).toBe(false);
    }
    expect([...new Set(images.map((m) => m.vendor))].sort()).toEqual(["google", "openai"]);
  });

  it("keeps Claude Sonnet 5 via OpenRouter as the only recommended model", () => {
    expect(MODEL_SNAPSHOT.filter((m) => m.recommended).map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("labels routes and vendors", () => {
    expect(findCatalogModel("openai-api/gpt-6-astra")?.providerLabel).toBe("OpenAI API");
    expect(findCatalogModel("anthropic/claude-sonnet-5")?.providerLabel).toBe("OpenRouter");
    expect(findCatalogModel("x-ai/grok-4.6")?.vendorLabel).toBe("xAI");
    expect(vendorLabel("someone-new")).toBe("someone-new");
  });

  it("findCatalogModel resolves ids and enforces kind", () => {
    expect(findCatalogModel("anthropic/claude-sonnet-5", "image")).toBeUndefined();
    expect(findCatalogModel("google/gemini-3.1-flash-image", "image")?.kind).toBe("image");
    expect(findCatalogModel("black-forest-labs/flux-schnell")).toBeUndefined();
  });

  it("fallbackPriceFor returns the snapshot prices and undefined for strangers", () => {
    expect(fallbackPriceFor("openai-api/gpt-6-astra")).toEqual({ input: 10, output: 50 });
    expect(fallbackPriceFor("nobody/nothing")).toBeUndefined();
  });
});
