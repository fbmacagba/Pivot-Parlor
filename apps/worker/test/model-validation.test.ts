/**
 * Explicit unknown/wrong-kind model ids submitted on the settings-save or
 * generate-site endpoints must be rejected (400) against the live
 * model registry (KV-seeded by test/setup-model-registry.ts). Model ids already stored in KV that have since fallen out
 * of the catalog (a catalog shrink) must silently degrade to the pipeline
 * defaults instead of 400ing, so legacy shops keep generating.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

type Captured = Record<string, unknown> | null;

let captured: Captured;
const envAny = env as unknown as { site_research_queue?: unknown };
const originalQueue = envAny.site_research_queue;

beforeEach(() => {
  captured = null;
  envAny.site_research_queue = {
    async send(message: Record<string, unknown>) {
      captured = message;
    },
  };
});

afterEach(() => {
  envAny.site_research_queue = originalQueue;
});

async function seedShopWithDev(): Promise<{
  shopId: string;
  devHeaders: Record<string, string>;
}> {
  const shopId = await seedShop("Model Validation Test Shop");
  const userId = await seedUser("developer", null);
  const token = await tokenFor(userId, "developer", null);
  return { shopId, devHeaders: authHeaders(token) };
}

describe("model id validation", () => {
  it("rejects an unknown text model on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { text_model: "meta-llama/llama-4-maverick" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown text model");
  });

  it("rejects a text model submitted as image model (wrong kind) on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { image_model: "anthropic/claude-sonnet-5" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown image model");
  });

  it("accepts a valid catalog model pair on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: {
        text_model: "deepseek/deepseek-v4-pro",
        image_model: "openai/gpt-5-image-mini",
      },
    });
    expect(res.status).toBe(200);
  });

  it("accepts direct OpenAI API and Anthropic API ids on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { text_model: "openai-api/gpt-6-astra" },
    });
    expect(res.status).toBe(200);
    const res2 = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { text_model: "anthropic-api/claude-fable-5.1" },
    });
    expect(res2.status).toBe(200);
  });

  it("rejects a malformed direct id (empty model part)", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { text_model: "openai-api/" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("Unknown text model");
  });

  it("forwards a direct id unchanged into the research queue payload", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true, text_model: "anthropic-api/claude-opus-5", text_effort: "medium" },
    });
    expect(res.status).toBe(202);
    expect(captured!.text_model).toBe("anthropic-api/claude-opus-5");
    expect(captured!.text_effort).toBe("medium");
  });

  it("rejects an unknown text model submitted directly to generate-site", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true, text_model: "meta-llama/llama-4-maverick" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown text model");
    expect(captured).toBeNull();
  });

  it("rejects an unknown image model on generate-image", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: devHeaders,
      body: { type: "logo", image_model: "black-forest-labs/flux-schnell" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown image model");
  });

  it("rejects a text model submitted as image model on generate-image", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: devHeaders,
      body: { type: "logo", image_model: "anthropic/claude-sonnet-5" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown image model");
  });

  it("does not 400 a valid catalog image model on generate-image", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: devHeaders,
      body: { type: "logo", image_model: "google/gemini-3.1-flash-lite-image" },
    });
    // The catalog gate must not reject a valid id. It may still fail later
    // (no real OpenRouter connectivity in tests) — that is not what this
    // asserts.
    expect(res.status).not.toBe(400);
  });

  it("degrades a legacy unknown model stored in KV to the default instead of 400ing", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    // Simulate a shop whose saved generation settings predate a catalog
    // shrink: write an id no longer in the catalog straight to KV, bypassing
    // settings-save validation, then confirm generate-site still succeeds.
    await env.KV.put(
      `gen:settings:${shopId}`,
      JSON.stringify({
        design_notes: "",
        text_model: "qwen/qwen3.7-max",
        text_effort: "",
        image_model: "",
      }),
      { expirationTtl: 60 * 60 * 24 }
    );

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.text_model).toBe("google/gemini-3.1-flash-lite-preview");
  });
});
