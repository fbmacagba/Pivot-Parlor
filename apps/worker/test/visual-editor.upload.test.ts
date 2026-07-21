import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { seedShop, seedUser, tokenFor } from "./helpers";

async function uploadImage(shopId: string, token: string, type: string): Promise<Response> {
  const fd = new FormData();
  fd.set("type", type);
  fd.set("file", new File([new Uint8Array([1, 2, 3, 4])], "x.png", { type: "image/png" }));
  const req = new Request(`https://worker.test/api/shops/${shopId}/upload-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req as never, env as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return res as unknown as Response;
}

describe("upload-image service:<id>", () => {
  it("accepts service:<id> for a service in the shop and returns an imageUrl", async () => {
    const shopId = await seedShop("Up Shop");
    const dev = await tokenFor(await seedUser("developer", null), "developer", null);
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'Fade', 30, 1000, 'Hair')"
    ).bind(svcId, shopId).run();

    const res = await uploadImage(shopId, dev, `service:${svcId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imageUrl?: string };
    expect(body.imageUrl).toContain(`/service-${svcId}.png`);
  });

  it("404s for a service not in the shop", async () => {
    const shopId = await seedShop("Up Shop 2");
    const other = await seedShop("Other Shop");
    const dev = await tokenFor(await seedUser("developer", null), "developer", null);
    const foreign = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'X', 30, 1000, 'Hair')"
    ).bind(foreign, other).run();

    const res = await uploadImage(shopId, dev, `service:${foreign}`);
    expect(res.status).toBe(404);
  });
});
