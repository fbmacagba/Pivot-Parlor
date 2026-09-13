import { describe, it, expect } from "vitest";
import { maxOutputTokensFor } from "../src/index";

describe("maxOutputTokensFor", () => {
  it("caps meta-llama models at 4096", () => {
    expect(maxOutputTokensFor("meta-llama/llama-4-maverick", 8000)).toBe(4096);
    expect(maxOutputTokensFor("meta-llama/llama-4-maverick", 1000)).toBe(1000);
  });

  it("caps Gemini 3.1 Flash Lite at 8000", () => {
    expect(maxOutputTokensFor("google/gemini-3.1-flash-lite-preview", 8000)).toBe(8000);
    expect(maxOutputTokensFor("google/gemini-3.1-flash-lite-preview", 9000)).toBe(8000);
  });

  it("applies the per-route default cap to everything else", () => {
    expect(maxOutputTokensFor("anthropic-api/claude-sonnet-5", 150)).toBe(150);
    expect(maxOutputTokensFor("openai-api/gpt-6-astra", 99_999)).toBe(16_384);
    expect(maxOutputTokensFor("anthropic/claude-sonnet-5", 99_999)).toBe(16_384);
  });

  it("never returns less than 1 and floors fractions", () => {
    expect(maxOutputTokensFor("x-ai/grok-4.6", 0)).toBe(1);
    expect(maxOutputTokensFor("x-ai/grok-4.6", 12.9)).toBe(12);
  });
});
