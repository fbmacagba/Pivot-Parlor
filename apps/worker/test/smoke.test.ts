import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedShop } from "./helpers";
import { dispatch } from "./request";

describe("test harness", () => {
  it("applies the schema and round-trips a row through D1", async () => {
    const shopId = await seedShop("Smoke Test Shop");
    const row = await env.DB.prepare("SELECT name FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ name: string }>();
    expect(row?.name).toBe("Smoke Test Shop");
  });

  it("serves requests through the real worker with auth enforced", async () => {
    const res = await dispatch("GET", "/api/shops");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});
