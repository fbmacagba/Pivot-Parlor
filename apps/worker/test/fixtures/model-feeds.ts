/**
 * Recorded 2026-09-12 from the three live lists: a subset covering the five
 * catalogue vendors plus the distractors the ranking rules must skip
 * (`:batch`/`:free` variants, `-pro` tiers, dated snapshots, `-exp`, image
 * models, legacy families). OpenRouter prices are USD per token, as served.
 * The snapshot in packages/utils/src/modelCatalog.ts is checked against
 * OPENROUTER_FEED by model-registry.test.ts; refresh both together.
 */
import type { AnthropicListedModel, OpenRouterFeedModel } from "../../src/services/model-registry";

function or(
  id: string,
  prompt: number,
  completion: number,
  opts: { name?: string; reasoning?: boolean; out?: string[] } = {},
): OpenRouterFeedModel {
  return {
    id,
    name: opts.name ?? id,
    pricing: { prompt: String(prompt), completion: String(completion) },
    supported_parameters: opts.reasoning === false ? ["max_tokens"] : ["max_tokens", "reasoning"],
    architecture: { output_modalities: opts.out ?? ["text"] },
  };
}

export const OPENROUTER_FEED: OpenRouterFeedModel[] = [
  // google
  or("google/gemini-2.5-pro", 0.00000125, 0.00001, { name: "Google: Gemini 2.5 Pro" }),
  or("google/gemini-3.1-pro-preview", 0.000002, 0.000012, { name: "Google: Gemini 3.1 Pro Preview" }),
  or("google/gemini-3.1-pro-preview:batch", 0.000001, 0.000006),
  or("google/gemini-3-flash-preview", 0.0000005, 0.000003),
  or("google/gemini-3.5-flash", 0.0000015, 0.000009, { name: "Google: Gemini 3.5 Flash" }),
  or("google/gemini-3.8-flash", 0.00000075, 0.00000375, { name: "Google: Gemini 3.8 Flash" }),
  or("google/gemini-3.8-flash:batch", 0.000000375, 0.000001875),
  or("google/gemini-3.1-flash-lite", 0.00000025, 0.0000015, { name: "Google: Gemini 3.1 Flash Lite" }),
  or("google/gemini-3.1-flash-lite-preview", 0.00000025, 0.0000015, { name: "Google: Gemini 3.1 Flash Lite Preview" }),
  or("google/gemini-3.5-flash-lite", 0.0000003, 0.0000025, { name: "Google: Gemini 3.5 Flash Lite" }),
  or("google/gemini-3.1-flash-image", 0.0000005, 0.000003, { name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", out: ["image", "text"] }),
  or("google/gemini-3.1-flash-lite-image", 0.00000025, 0.0000015, { out: ["image", "text"] }),
  or("google/gemini-3-pro-image", 0.000002, 0.000012, { out: ["image", "text"] }),
  or("google/gemma-4-31b-it", 0.00000009, 0.00000034),
  // anthropic
  or("anthropic/claude-3-haiku", 0.00000025, 0.00000125, { reasoning: false }),
  or("anthropic/claude-fable-5", 0.00001, 0.00005),
  or("anthropic/claude-fable-5.1", 0.00001, 0.00005, { name: "Anthropic: Claude Fable 5.1" }),
  or("anthropic/claude-fable-5.1:batch", 0.000005, 0.000025),
  or("anthropic/claude-opus-4.8", 0.000005, 0.000025, { name: "Anthropic: Claude Opus 4.8" }),
  or("anthropic/claude-opus-5", 0.000005, 0.000025, { name: "Claude Opus 5" }),
  or("anthropic/claude-sonnet-4.6", 0.000003, 0.000015),
  or("anthropic/claude-sonnet-5", 0.000002, 0.00001, { name: "Anthropic: Claude Sonnet 5" }),
  or("anthropic/claude-haiku-4.5", 0.000001, 0.000005, { name: "Anthropic: Claude Haiku 4.5" }),
  // openai
  or("openai/gpt-6-astra", 0.00001, 0.00005, { name: "OpenAI: GPT-6 Astra" }),
  or("openai/gpt-6-astra-pro", 0.00001, 0.00005),
  or("openai/gpt-6-astra:batch", 0.000005, 0.000025),
  or("openai/gpt-5.6-sol", 0.000002, 0.00001, { name: "OpenAI: GPT-5.6 Sol" }),
  or("openai/gpt-5.6-sol-pro", 0.000002, 0.00001),
  or("openai/gpt-5.6-terra", 0.000002, 0.000012, { name: "OpenAI: GPT-5.6 Terra" }),
  or("openai/gpt-5.6-luna", 0.0000002, 0.0000012, { name: "OpenAI: GPT-5.6 Luna" }),
  or("openai/gpt-5.5", 0.000005, 0.00003),
  or("openai/gpt-5.4-mini", 0.00000075, 0.0000045),
  or("openai/gpt-chat-latest", 0.000005, 0.00003, { reasoning: false }),
  or("openai/gpt-4o-2024-11-20", 0.0000025, 0.00001, { reasoning: false }),
  or("openai/gpt-5-image-mini", 0.0000025, 0.000002, { out: ["image", "text"] }),
  or("openai/gpt-5.4-image-2", 0.000008, 0.000015, { out: ["image", "text"] }),
  // x-ai
  or("x-ai/grok-4.20", 0.00000125, 0.0000025),
  or("x-ai/grok-4.20-multi-agent", 0.00000125, 0.0000025, { name: "SpaceXAI: Grok 4.20 Multi-Agent" }),
  or("x-ai/grok-4.3", 0.00000125, 0.0000025),
  or("x-ai/grok-4.5", 0.000002, 0.000006),
  or("x-ai/grok-4.6", 0.000002, 0.000006, { name: "SpaceXAI: Grok 4.6" }),
  or("x-ai/grok-build-0.1", 0.000001, 0.000002),
  // deepseek
  or("deepseek/deepseek-v3.2-exp", 0.00000027, 0.00000041),
  or("deepseek/deepseek-v4-flash", 0.00000006734, 0.00000013468),
  or("deepseek/deepseek-v4-flash-0731", 0.000000065, 0.00000018),
  or("deepseek/deepseek-v4-pro", 0.000000849816, 0.000001699632, { name: "DeepSeek: DeepSeek V4 Pro 0423" }),
  or("deepseek/deepseek-v4-pro-0813", 0.00000057816, 0.00000173448),
  or("deepseek/deepseek-v4.1-flash", 0.00000015, 0.0000006, { name: "DeepSeek: DeepSeek V4.1 Flash" }),
];

/** OpenAI `GET /v1/models` ids (only `id` matters to the ranking). */
export const OPENAI_IDS: string[] = [
  "gpt-6-astra",
  "gpt-6-astra-pro",
  "gpt-5.6-sol",
  "gpt-5.6-sol-pro",
  "gpt-5.6-terra",
  "gpt-5.6-terra-pro",
  "gpt-5.6-luna",
  "gpt-5.6-luna-pro",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-chat-latest",
  "gpt-5-image-mini",
  "gpt-4o",
  "o3",
  "text-embedding-3-small",
];

/** Anthropic `GET /v1/models` entries; `claude-sonnet-4-6-20260210` exercises canonicalisation. */
export const ANTHROPIC_MODELS: AnthropicListedModel[] = [
  { id: "claude-fable-5.1", display_name: "Claude Fable 5.1", capabilities: { effort: { supported: ["low", "medium", "high", "max", "xhigh"] } } },
  { id: "claude-fable-5", display_name: "Claude Fable 5", capabilities: { effort: { supported: ["low", "medium", "high", "max"] } } },
  { id: "claude-opus-5", display_name: "Claude Opus 5", capabilities: { effort: { supported: ["low", "medium", "high", "max"] } } },
  { id: "claude-opus-4.8", display_name: "Claude Opus 4.8", capabilities: { effort: { supported: ["low", "medium", "high"] } } },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", capabilities: { effort: { supported: ["medium", "high"] } } },
  { id: "claude-sonnet-4-6-20260210", display_name: "Claude Sonnet 4.6", capabilities: { effort: { supported: ["low", "medium", "high"] } } },
  { id: "claude-haiku-4.5", display_name: "Claude Haiku 4.5", capabilities: { effort: { supported: ["low", "medium", "high"] } } },
  { id: "claude-3-haiku-20240307", display_name: "Claude 3 Haiku" },
];

/** Stub body factories for tests that intercept globalThis.fetch. */
export const feedResponses = {
  openrouter: () => Response.json({ data: OPENROUTER_FEED }),
  openai: () => Response.json({ object: "list", data: OPENAI_IDS.map((id) => ({ id, object: "model", owned_by: "openai" })) }),
  anthropic: () => Response.json({ data: ANTHROPIC_MODELS, has_more: false, first_id: "claude-fable-5.1", last_id: "claude-3-haiku-20240307" }),
};
