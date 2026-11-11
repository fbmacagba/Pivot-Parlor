/**
 * A shop's generated site is public only once it is live. Before that (draft)
 * or while it is taken down (paused), GET /api/shops/:shopId/site tells the
 * public only the status, which is all the public shop page needs to answer
 * 404 or 503, and the public services list carries no generated copy. A
 * developer, or the shop's own admin, still reads everything (the developer
 * preview and onboarding depend on it).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, bareTokenFor, seedShop, seedUser, tokenFor } from "./helpers";

const HEADLINE = "Draft headline nobody should see yet";
const COPY = "Generated copy for the fade.";

async function slugOf(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
}

/** A shop with one real service and a generated site in the given state. */
async function shopWithSite(websiteStatus: string): Promise<string> {
  const shopId = await seedShop(`Site ${websiteStatus} ${crypto.randomUUID().slice(0, 6)}`);
  await env.DB.prepare(
    `INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active)
     VALUES (?, ?, 'Skin fade', 30, 2000, 'Cuts', 1)`,
  )
    .bind(crypto.randomUUID(), shopId)
    .run();
  await env.DB.prepare(
    `INSERT INTO shop_sites (id, shop_id, template, headline, tagline, services_json, website_status)
     VALUES (?, ?, 'classic', ?, 'A tagline', ?, ?)`,
  )
    .bind(crypto.randomUUID(), shopId, HEADLINE, JSON.stringify([{ name: "Skin fade", description: COPY }]), websiteStatus)
    .run();
  return shopId;
}

async function readSite(key: string, token?: string) {
  const res = await dispatch("GET", `/api/shops/${key}/site`, token ? { headers: authHeaders(token) } : undefined);
  const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
  return { res, body };
}

async function readServices(key: string, token?: string) {
  const res = await dispatch("GET", `/api/shops/${key}/services`, token ? { headers: authHeaders(token) } : undefined);
  return ((await res.json()) as { data: Array<{ name: string; description: string; price_pence: number }> }).data;
}

const developer = async () => tokenFor(await seedUser("developer", null), "developer", null);
const adminOf = async (shopId: string) => tokenFor(await seedUser("admin", shopId), "admin", shopId);

describe("GET /api/shops/:shopId/site for a site that is not live", () => {
  it.each(["draft", "paused"])("tells the public only the status of a %s site", async (status) => {
    const shopId = await shopWithSite(status);
    const { res, body } = await readSite(shopId);
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { website_status: status } });
  });

  it("serves a live site in full to the public (control)", async () => {
    const shopId = await shopWithSite("live");
    const { body } = await readSite(shopId);
    expect(body.data.headline).toBe(HEADLINE);
    expect(body.data.website_status).toBe("live");
  });

  it("serves a draft site in full to a developer, never cached", async () => {
    const shopId = await shopWithSite("draft");
    const { res, body } = await readSite(await slugOf(shopId), await developer());
    expect(body.data.headline).toBe(HEADLINE);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves a draft site in full to the shop's own admin, by slug as well as by id", async () => {
    const shopId = await shopWithSite("draft");
    const token = await adminOf(shopId);
    expect((await readSite(shopId, token)).body.data.headline).toBe(HEADLINE);
    expect((await readSite(await slugOf(shopId), token)).body.data.headline).toBe(HEADLINE);
  });

  it("gives another shop's admin, staff and customers only the status", async () => {
    const shopId = await shopWithSite("draft");
    const otherShop = await seedShop("Other Shop");
    const tokens = [
      await adminOf(otherShop),
      await tokenFor(await seedUser("staff", shopId), "staff", shopId),
      await tokenFor(await seedUser("customer", null), "customer", null),
    ];
    for (const token of tokens) {
      expect((await readSite(shopId, token)).body).toEqual({ success: true, data: { website_status: "draft" } });
    }
  });

  it("treats a revoked or forged session as the public, without refusing the request", async () => {
    const shopId = await shopWithSite("draft");
    const revoked = await bareTokenFor(await seedUser("developer", null), "developer", null); // signed, no live session
    for (const token of [revoked, "not.a.jwt"]) {
      const { res, body } = await readSite(shopId, token);
      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true, data: { website_status: "draft" } });
    }
  });

  it("does not leak a full copy cached by an earlier authorised read", async () => {
    const shopId = await shopWithSite("draft");
    expect((await readSite(shopId, await developer())).body.data.headline).toBe(HEADLINE);
    expect((await readSite(shopId)).body).toEqual({ success: true, data: { website_status: "draft" } });
  });

  it("still answers 404 when no site has been generated", async () => {
    const shopId = await seedShop("No Site Shop");
    expect((await readSite(shopId)).res.status).toBe(404);
  });
});

describe("GET /api/shops/:shopId/services for a site that is not live", () => {
  it("lists the real services for the public, without the generated copy", async () => {
    const shopId = await shopWithSite("draft");
    expect(await readServices(shopId)).toEqual([
      expect.objectContaining({ name: "Skin fade", price_pence: 2000, description: "" }),
    ]);
  });

  it("keeps the generated copy for a live site (control) and for the shop's own admin", async () => {
    const live = await shopWithSite("live");
    expect((await readServices(live))[0].description).toBe(COPY);
    const draft = await shopWithSite("draft");
    expect((await readServices(draft, await adminOf(draft)))[0].description).toBe(COPY);
  });
});
