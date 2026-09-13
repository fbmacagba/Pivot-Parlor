import { describe, it, expect } from "vitest";
import { parseModelId, isValidModelId, priceTwin } from "../src/index";

describe("parseModelId", () => {
  it("routes openai-api/ ids to OpenAI with the vendor model id", () => {
    expect(parseModelId("openai-api/gpt-6-astra")).toEqual({ route: "openai", model: "gpt-6-astra" });
  });

  it("routes anthropic-api/ ids to Anthropic", () => {
    expect(parseModelId("anthropic-api/claude-fable-5.1")).toEqual({
      route: "anthropic",
      model: "claude-fable-5.1",
    });
  });

  it("treats every other id as an OpenRouter slug, unchanged", () => {
    expect(parseModelId("anthropic/claude-sonnet-5")).toEqual({
      route: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
    expect(parseModelId("google/gemini-3.1-flash-lite-preview").route).toBe("openrouter");
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelId("  openai-api/gpt-6-astra ")).toEqual({ route: "openai", model: "gpt-6-astra" });
  });

  it("throws on an empty model part and isValidModelId reports it", () => {
    for (const bad of ["", "   ", "openai-api/", "anthropic-api/", "openai-api/   "]) {
      expect(() => parseModelId(bad)).toThrow(/Malformed model id/);
      expect(isValidModelId(bad)).toBe(false);
    }
    expect(isValidModelId("openai-api/gpt-6-astra")).toBe(true);
    expect(isValidModelId("x-ai/grok-4.6")).toBe(true);
  });
});

describe("priceTwin", () => {
  it("maps direct ids to their OpenRouter slug", () => {
    expect(priceTwin("openai-api/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(priceTwin("anthropic-api/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("is the identity for OpenRouter ids", () => {
    expect(priceTwin("x-ai/grok-4.6")).toBe("x-ai/grok-4.6");
  });
});
