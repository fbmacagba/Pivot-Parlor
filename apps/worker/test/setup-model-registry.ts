/**
 * Test setup: pre-seed the model registry cache so route handlers that
 * validate model ids (settings-save, generate-site, generate-image, theme
 * generation, chatbot-model) never reach the network. Tests that exercise the
 * refresh path delete MODELS_KV_KEY themselves and stub fetch.
 */
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { buildRegistry, MODELS_KV_KEY } from "../src/services/model-registry";
import { ANTHROPIC_MODELS, OPENAI_IDS, OPENROUTER_FEED } from "./fixtures/model-feeds";

beforeAll(async () => {
  const { models } = buildRegistry({
    openrouter: { ok: true, data: OPENROUTER_FEED },
    openai: { ok: true, data: OPENAI_IDS },
    anthropic: { ok: true, data: ANTHROPIC_MODELS },
    previous: null,
  });
  await env.KV.put(MODELS_KV_KEY, JSON.stringify(models));
});
