/**
 * Complete generated shop sites (migration 048):
 *  - generate-site sends the owner's real facts (team, specialities, area,
 *    hours, categories) and ONLY the real services, never "Default service"
 *    padding, and no longer takes a live site offline while it regenerates.
 *  - booking-staff exposes the public portrait and speciality, nothing private.
 *  - the public services list carries the generated description for each
 *    real service; /site carries the generated gallery.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";
import { buildSiteResearchBusiness, hoursFromJson, localityFromAddress } from "../src/lib/siteResearchContext";

let captured: Record<string, unknown> | null;
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

async function addService(shopId: string, name: string, pence: number, minutes: number, category: string) {
  await env.DB.prepare(
    `INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(crypto.randomUUID(), shopId, name, minutes, pence, category)
    .run();
}

async function addSite(shopId: string, fields: { status?: string; services_json?: string; gallery?: string[] }) {
  await env.DB.prepare(
    `INSERT INTO shop_sites (id, shop_id, template, headline, services_json, website_status, gallery_images_json)
     VALUES (?, ?, 'classic', 'Headline', ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      shopId,
      fields.services_json ?? "[]",
      fields.status ?? "live",
      fields.gallery ? JSON.stringify(fields.gallery) : null,
    )
    .run();
}

async function devToken(): Promise<string> {
  return tokenFor(await seedUser("developer", null), "developer", null);
}

describe("generate-site research inputs", () => {
  it("forwards the owner's facts and only the real services", async () => {
    const shopId = await seedShop("Facts Barber");
    const staffId = await seedStaff(shopId);
    await env.DB.prepare("UPDATE staff SET display_name = 'Kofi Asante', speciality = 'Skin fades' WHERE id = ?")
      .bind(staffId)
      .run();
    await addService(shopId, "Skin fade", 2400, 40, "Cuts");
    await env.DB.prepare(
      "INSERT INTO shop_settings (shop_id, address, hours_json) VALUES (?, ?, ?)",
    )
      .bind(shopId, "12 Example Row, Deptford, London SE8 4AA", JSON.stringify({ tue: "9:00-18:00", sat: "10:00-16:00" }))
      .run();

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(await devToken()),
      body: { skip_images: true },
    });
    expect(res.status).toBe(202);
    expect(captured).not.toBeNull();

    const services = captured!.services as Array<{ name: string; price_gbp: number; category?: string }>;
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ name: "Skin fade", price_gbp: 24, category: "Cuts" });
    expect(JSON.stringify(captured)).not.toMatch(/Default service/);

    expect(captured!.business).toEqual({
      locality: "Deptford, London",
      hours: { mon: "closed", tue: "9:00-18:00", wed: "closed", thu: "closed", fri: "closed", sat: "10:00-16:00", sun: "closed" },
      team: [{ name: "Kofi Asante", speciality: "Skin fades" }],
      categories: ["Cuts"],
    });
  });

  it("sends an empty menu rather than inventing placeholder services", async () => {
    const shopId = await seedShop("Empty Menu");
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(await devToken()),
      body: { skip_images: true },
    });
    expect(res.status).toBe(202);
    expect(captured!.services).toEqual([]);
  });

  it("keeps a live site live while it regenerates", async () => {
    const shopId = await seedShop("Live Shop");
    await addSite(shopId, { status: "live" });
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(await devToken()),
      body: { skip_images: true },
    });
    expect(res.status).toBe(202);
    const row = await env.DB.prepare("SELECT website_status FROM shop_sites WHERE shop_id = ?")
      .bind(shopId)
      .first<{ website_status: string }>();
    expect(row?.website_status).toBe("live");
  });
});

describe("public profile and copy joins", () => {
  it("booking-staff exposes portrait and speciality but no private fields", async () => {
    const shopId = await seedShop("Profile Shop");
    const staffId = await seedStaff(shopId);
    await env.DB.prepare("UPDATE staff SET avatar_url = ?, speciality = ? WHERE id = ?")
      .bind("https://assets.example/staff/kofi.jpg", "Skin fades and beard sculpting", staffId)
      .run();
    const res = await dispatch("GET", `/api/shops/${shopId}/booking-staff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      id: staffId,
      avatar_url: "https://assets.example/staff/kofi.jpg",
      speciality: "Skin fades and beard sculpting",
    });
    expect(Object.keys(body.data[0]!).sort()).toEqual(["avatar_url", "display_name", "id", "speciality"]);
  });

  it("serves an uploaded staff portrait at the URL the upload records", async () => {
    const shopId = await seedShop("Portrait Shop");
    const staffId = await seedStaff(shopId);
    const admin = await tokenFor(await seedUser("admin", shopId), "admin", shopId);
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const form = new FormData();
    form.append("file", new File([bytes], "kofi.webp", { type: "image/webp" }));
    // Multipart, so not dispatch() (which JSON-encodes the body).
    const ctx = createExecutionContext();
    const upload = (await worker.fetch(
      new Request(`https://worker.test/api/shops/${shopId}/staff/${staffId}/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${admin}` },
        body: form,
      }) as never,
      env as never,
      ctx as never,
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    expect(upload.status).toBe(200);
    const { avatarUrl } = (await upload.json()) as { avatarUrl: string };
    const url = new URL(avatarUrl);
    expect(url.pathname).toBe(`/staff/${shopId}/${staffId}/avatar.webp`);
    expect(url.searchParams.get("v")).toBeTruthy();

    const res = await dispatch("GET", url.pathname + url.search);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    expect((await dispatch("GET", `/staff/${shopId}/${staffId}/other.webp`)).status).toBe(404);
    expect((await dispatch("GET", `/staff/${shopId}/nobody/avatar.webp`)).status).toBe(404);
  });

  it("services carry the generated description for the matching real service", async () => {
    const shopId = await seedShop("Copy Shop");
    await addService(shopId, "Beard sculpt & line-up", 1500, 20, "Beard");
    await addService(shopId, "Hot towel shave", 2200, 30, "Beard");
    await addSite(shopId, {
      services_json: JSON.stringify([
        { name: "Beard Sculpt and Line Up", description: "Clipper shape, razor finish." },
        { name: "Invented service", description: "Never shown." },
      ]),
    });
    const res = await dispatch("GET", `/api/shops/${shopId}/services`);
    const body = (await res.json()) as { data: Array<{ name: string; description: string }> };
    const byName = Object.fromEntries(body.data.map((s) => [s.name, s.description]));
    expect(byName).toEqual({ "Beard sculpt & line-up": "Clipper shape, razor finish.", "Hot towel shave": "" });
  });

  it("/site carries the generated gallery and drops blank slots", async () => {
    const shopId = await seedShop("Gallery Shop");
    await addSite(shopId, { gallery: ["https://assets.example/g1.png", "", "https://assets.example/g3.png"] });
    const res = await dispatch("GET", `/api/shops/${shopId}/site`);
    const body = (await res.json()) as { data: { gallery_images: string[] } };
    expect(body.data.gallery_images).toEqual(["https://assets.example/g1.png", "https://assets.example/g3.png"]);
  });
});

describe("siteResearchContext", () => {
  it("keeps the locality and drops the street line and postcode", () => {
    expect(localityFromAddress("12 Example Row, Deptford, London SE8 4AA")).toBe("Deptford, London");
    expect(localityFromAddress("12 Example Row")).toBeUndefined();
    expect(localityFromAddress(null)).toBeUndefined();
  });

  it("treats all-closed or unreadable hours as unknown", () => {
    expect(hoursFromJson("{}")).toBeUndefined();
    expect(hoursFromJson('{"mon":"","tue":"Closed","wed":"CLOSED"}')).toBeUndefined();
    expect(hoursFromJson("not json")).toBeUndefined();
    expect(hoursFromJson('{"sun":"11:00-15:00"}')?.sun).toBe("11:00-15:00");
  });

  it("dedupes categories and ignores the generic one", () => {
    const b = buildSiteResearchBusiness({
      staff: [{ display_name: " Isla Brennan ", speciality: "  " }],
      services: [{ category: "Colour" }, { category: "service" }, { category: "Colour" }, { category: "Cuts" }],
    });
    expect(b).toEqual({ team: [{ name: "Isla Brennan" }], categories: ["Colour", "Cuts"] });
  });
});
