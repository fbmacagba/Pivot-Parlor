/**
 * Regression: POST /api/shops/:shopId/generate-site must forward an owner-chosen
 * palette into the site-research queue payload — but only as a complete, valid
 * 6-digit hex pair. A partial or malformed value must never override the
 * AI-generated palette (it is simply omitted, leaving the pipeline to choose).
 *
 * The vitest config does not declare the site_research_queue producer, so we
 * stub the binding on the shared `env` to capture what the handler enqueues.
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
  const shopId = await seedShop("Palette Test Shop");
  const userId = await seedUser("developer", null);
  const token = await tokenFor(userId, "developer", null);
  return { shopId, token };
}

describe("generate-site palette override", () => {
  it("forwards a valid hex pair into the queue payload", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true, color_primary: "#0D0D0D", color_accent: "#C9A84C" },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.color_primary).toBe("#0D0D0D");
    expect(captured!.color_accent).toBe("#C9A84C");
  });

  it("omits colours when only one of the pair is supplied", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true, color_primary: "#0D0D0D" },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.color_primary).toBeUndefined();
    expect(captured!.color_accent).toBeUndefined();
  });

  it("omits colours when the value is not a 6-digit hex", async () => {
    const { shopId, token } = await devTokenForShop();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: { skip_images: true, color_primary: "red", color_accent: "#fff" },
    });

    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();
    expect(captured!.color_primary).toBeUndefined();
    expect(captured!.color_accent).toBeUndefined();
  });
});
