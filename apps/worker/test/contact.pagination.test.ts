import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedUser, tokenFor, authHeaders } from "./helpers";
import { dispatch } from "./request";

let devToken: string;

beforeAll(async () => {
  devToken = await tokenFor(await seedUser("developer", null), "developer", null);
  // Seed 3 enquiries with distinct, ordered created_at so DESC order is deterministic.
  for (let i = 0; i < 3; i++) {
    await env.DB.prepare(
      `INSERT INTO contacts (id, full_name, shop_name, shop_type, email, created_at)
       VALUES (?, ?, 'S', 'barber_shop', 'e@test.local', ?)`
    )
      .bind(`pg-${i}`, `Contact ${i}`, `2027-06-0${i + 1}T00:00:00Z`)
      .run();
  }
});

describe("contacts list pagination (T8.4)", () => {
  it("requires developer role", async () => {
    const res = await dispatch("GET", "/api/contact");
    expect(res.status).toBe(401);
  });

  it("honours limit and offset", async () => {
    const page1 = await dispatch("GET", "/api/contact?limit=2&offset=0", {
      headers: authHeaders(devToken),
    });
    const b1 = (await page1.json()) as { data: unknown[] };
    expect(b1.data.length).toBe(2);

    const page2 = await dispatch("GET", "/api/contact?limit=2&offset=2", {
      headers: authHeaders(devToken),
    });
    const b2 = (await page2.json()) as { data: unknown[] };
    expect(b2.data.length).toBeGreaterThanOrEqual(1);
  });

  it("clamps an out-of-range limit instead of failing", async () => {
    const res = await dispatch("GET", "/api/contact?limit=99999", {
      headers: authHeaders(devToken),
    });
    expect(res.status).toBe(200);
  });
});
