/**
 * Design Director composer selection (ai|seed) is threaded through the
 * settings-save and generate-site endpoints via parseComposer. An explicit
 * invalid composer must 400 on both handlers; body wins over stored
 * settings; a stored-but-invalid value silently defaults; the final default
 * is "ai"; the generate-site queue payload always carries composer.
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
  const shopId = await seedShop("Composer Test Shop");
  const userId = await seedUser("developer", null);
  const token = await tokenFor(userId, "developer", null);
  return { shopId, devHeaders: authHeaders(token) };
}

describe("composer option", () => {
  it("rejects an unknown composer on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { composer: "vibes" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown composer");
  });

  it("accepts and stores a valid composer on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const settingsRes = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { composer: "seed" },
    });
    expect(settingsRes.status).toBe(200);

    const genRes = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true },
    });
    expect(genRes.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.composer).toBe("seed");
  });

  it("rejects an unknown composer on generate-site", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true, composer: "vibes" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown composer");
    expect(captured).toBeNull();
  });

  it("body composer wins over stored settings", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const settingsRes = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { composer: "seed" },
    });
    expect(settingsRes.status).toBe(200);

    const genRes = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true, composer: "ai" },
    });
    expect(genRes.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.composer).toBe("ai");
  });

  it("defaults to ai when nothing is set", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true },
    });
    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.composer).toBe("ai");
  });

  it("degrades a legacy stored-invalid composer to ai instead of 400ing", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    // Simulate a shop whose saved generation settings have an invalid composer
    // value (e.g., from before validation existed). Seed it directly to KV,
    // bypassing settings-save validation, then confirm generate-site still
    // succeeds and degrades to "ai".
    await env.KV.put(
      `gen:settings:${shopId}`,
      JSON.stringify({
        design_notes: "",
        text_model: "",
        text_effort: "",
        image_model: "",
        composer: "vibes",
      }),
      { expirationTtl: 60 * 60 * 24 }
    );

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.composer).toBe("ai");
  });
});
