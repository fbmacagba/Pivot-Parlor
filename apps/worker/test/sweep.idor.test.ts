import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";

let shopA: string, shopB: string;
let staffB: string;
let serviceB: string;
let adminAToken: string;

beforeAll(async () => {
  shopA = await seedShop("Shop A");
  shopB = await seedShop("Shop B");
  staffB = await seedStaff(shopB);
  serviceB = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence) VALUES (?, ?, 'Cut B', 30, 2500)"
  )
    .bind(serviceB, shopB)
    .run();
  adminAToken = await tokenFor(await seedUser("admin", shopA), "admin", shopA);
});

describe("IDOR sweep regression (T1.4)", () => {
  it("staff: admin of shop A cannot read a shop B staff member through their own shop URL", async () => {
    const res = await dispatch("GET", `/api/shops/${shopA}/staff/${staffB}`, {
      headers: authHeaders(adminAToken),
    });
    expect(res.status).toBe(404);
  });

  it("staff: shop B staff member is readable through shop B's URL by its own admin", async () => {
    const adminBToken = await tokenFor(await seedUser("admin", shopB), "admin", shopB);
    const res = await dispatch("GET", `/api/shops/${shopB}/staff/${staffB}`, {
      headers: authHeaders(adminBToken),
    });
    expect(res.status).toBe(200);
  });

  it("services: a service is not readable through another shop's URL", async () => {
    const res = await dispatch("GET", `/api/shops/${shopA}/services/${serviceB}`);
    expect(res.status).toBe(404);
  });

  it("services: a service is readable through its own shop's URL", async () => {
    const res = await dispatch("GET", `/api/shops/${shopB}/services/${serviceB}`);
    expect(res.status).toBe(200);
  });
});
