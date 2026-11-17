/**
 * POST /api/shops/:shopId/generate-site must forward the developer-chosen
 * text model and reasoning effort into the site-research queue payload —
 * and must drop anything that is not low/medium/high so a garbage effort can
 * never reach the pipeline.
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

async function devTokenForShop(): Promise<{ shopId: string; token: string }> {
  const shopId = await seedShop("Model Effort Test Shop");
  const userId = await seedUser("developer", null);
  const token = await tokenFor(userId, "developer", null);
  return { shopId, token };
}

describe("generate-site model + effort forwarding", () => {
  it("forwards the chosen text model and a valid effort", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true, text_model: "anthropic/claude-sonnet-5.5", text_effort: "high" },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.text_model).toBe("anthropic/claude-sonnet-5.5");
    expect(captured!.text_effort).toBe("high");
  });

  it("drops an invalid effort but keeps the model", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true, text_model: "x-ai/grok-4.7", text_effort: "turbo" },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.text_model).toBe("x-ai/grok-4.7");
    expect(captured!.text_effort).toBeUndefined();
  });

  it("defaults the model and omits effort when neither is supplied", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.text_model).toBe("google/gemini-3.1-flash-lite-preview");
    expect(captured!.text_effort).toBeUndefined();
  });

  it("falls back to the effort saved in generation settings", async () => {
    const { shopId, token } = await devTokenForShop();

    const save = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: authHeaders(token),
      body: { text_model: "deepseek/deepseek-v4-pro", text_effort: "xhigh" },
    });
    expect(save.status).toBe(200);

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.text_model).toBe("deepseek/deepseek-v4-pro");
    expect(captured!.text_effort).toBe("xhigh");
  });

  it("drops a saved effort the model does not take, so the model's default runs", async () => {
    const { shopId, token } = await devTokenForShop();

    // DeepSeek V4 Pro takes none, high and xhigh only (recorded feed).
    const save = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: authHeaders(token),
      body: { text_model: "deepseek/deepseek-v4-pro", text_effort: "medium" },
    });
    expect(save.status).toBe(200);

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true },
    });

    expect(res.status).toBe(202);
    expect(captured!.text_model).toBe("deepseek/deepseek-v4-pro");
    expect(captured!.text_effort).toBeUndefined();
  });

  it("queues the model's own default as a sizing hint when no level is chosen", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true, text_model: "z-ai/glm-5.3" },
    });

    expect(res.status).toBe(202);
    expect(captured!.text_effort).toBeUndefined();
    expect(captured!.text_effort_default).toBe("max");
  });

  it("forwards a level beyond high when the model takes it", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true, text_model: "anthropic/claude-opus-5.5", text_effort: "max" },
    });

    expect(res.status).toBe(202);
    expect(captured!.text_effort).toBe("max");
  });
});
