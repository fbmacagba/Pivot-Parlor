/**
 * Platform-wide chatbot model choice: developer-only, validated as a listed
 * text model, stored in KV under platform:chatbot:model. The read and
 * settings routes under /api/ai must not consume the 10/hour AI generation
 * budget (Decision 4 in the plan).
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";
import { CHATBOT_MODEL_KV_KEY } from "../src/routes/ai";

async function devHeaders(): Promise<Record<string, string>> {
  const userId = await seedUser("developer", null);
  return authHeaders(await tokenFor(userId, "developer", null));
}

describe("chatbot model endpoints", () => {
  // The workers pool isolates storage per test file, not per test.
  beforeEach(async () => {
    await env.KV.delete(CHATBOT_MODEL_KV_KEY);
  });

  it("reports nulls before anything is saved", async () => {
    const res = await dispatch("GET", "/api/ai/chatbot-model", { headers: await devHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { model_id: null, updated_at: null } });
  });

  it("saves a listed text model and reads it back", async () => {
    const headers = await devHeaders();
    const save = await dispatch("POST", "/api/ai/chatbot-model", {
      headers,
      body: { model_id: "openai-api/gpt-6-astra" },
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { data: { model_id: string; updated_at: string } };
    expect(saved.data.model_id).toBe("openai-api/gpt-6-astra");
    expect(Number.isNaN(Date.parse(saved.data.updated_at))).toBe(false);

    const stored = JSON.parse((await env.KV.get(CHATBOT_MODEL_KV_KEY)) ?? "{}") as Record<string, unknown>;
    expect(stored.model_id).toBe("openai-api/gpt-6-astra");

    const read = await dispatch("GET", "/api/ai/chatbot-model", { headers });
    expect(((await read.json()) as { data: { model_id: string } }).data.model_id).toBe("openai-api/gpt-6-astra");
  });

  it("rejects missing, unknown, wrong-kind and malformed ids with 400", async () => {
    const headers = await devHeaders();
    const cases: Array<[unknown, string]> = [
      [undefined, "model_id is required"],
      ["", "model_id is required"],
      ["qwen/qwen3.7-max", "Unknown text model: qwen/qwen3.7-max"],
      ["google/gemini-3.1-flash-image", "Unknown text model: google/gemini-3.1-flash-image"],
      ["openai-api/", "Unknown text model: openai-api/"],
    ];
    for (const [model_id, error] of cases) {
      const res = await dispatch("POST", "/api/ai/chatbot-model", {
        headers,
        body: model_id === undefined ? {} : { model_id },
      });
      expect(res.status, String(model_id)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect(await env.KV.get(CHATBOT_MODEL_KV_KEY)).toBeNull();
  });

  it("is developer-only", async () => {
    const shopId = await seedShop("Chatbot Model RBAC Shop");
    const adminId = await seedUser("admin", shopId);
    const headers = authHeaders(await tokenFor(adminId, "admin", shopId));
    expect((await dispatch("GET", "/api/ai/chatbot-model", { headers })).status).toBe(403);
    expect((await dispatch("POST", "/api/ai/chatbot-model", { headers, body: { model_id: "anthropic/claude-sonnet-5" } })).status).toBe(403);
  });
});

describe("AI read routes and the generation rate limit", () => {
  it("lets a developer read /models more than ten times an hour", async () => {
    const headers = await devHeaders();
    for (let i = 0; i < 12; i++) {
      const res = await dispatch("GET", "/api/ai/models", { headers });
      expect(res.status, `call ${i + 1}`).toBe(200);
    }
    const setting = await dispatch("POST", "/api/ai/chatbot-model", { headers, body: { model_id: "anthropic/claude-sonnet-5" } });
    expect(setting.status).toBe(200);
  });
});
