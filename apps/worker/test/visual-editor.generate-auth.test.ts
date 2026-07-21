import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

describe("generate-image auth + type", () => {
  it("403s for an admin of the shop (regenerate is developer-only)", async () => {
    const shopId = await seedShop("Gen Shop");
    const admin = authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: admin,
      body: { type: "logo" },
    });
    expect(res.status).toBe(403);
  });

  it("400s for an unknown type from a developer", async () => {
    const shopId = await seedShop("Gen Shop 2");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: dev,
      body: { type: "banner" },
    });
    expect(res.status).toBe(400);
  });

  it("404s for a developer regenerating a service not in the shop", async () => {
    const shopId = await seedShop("Gen Shop 3");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: dev,
      body: { type: `service:svc-${crypto.randomUUID()}` },
    });
    expect(res.status).toBe(404);
  });
});
