import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";

/**
 * WS-7: the remaining public writes (waitlist, walk-in join, reviews) must be
 * rate-limited, length-capped, and tenant-validated. Rate-limit floods happen
 * inside a single test each (isolated storage resets KV between tests).
 */

async function seedService(shopId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)"
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function slugOf(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ slug: string }>();
  return row!.slug;
}

async function seedBooking(
  shopId: string,
  opts: { date: string; status?: string; email?: string }
): Promise<string> {
  const staffId = await seedStaff(shopId);
  const serviceId = await seedService(shopId);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', ?, ?, ?, ?, ?, 2500)`
  )
    .bind(
      id,
      shopId,
      staffId,
      serviceId,
      opts.email ?? "cust@test.local",
      opts.date,
      `${opts.date}T10:00:00.000Z`,
      `${opts.date}T10:30:00.000Z`,
      opts.status ?? "confirmed"
    )
    .run();
  return id;
}

// ─── Waitlist ─────────────────────────────────────────────────────────────────

describe("POST /api/waitlist validation", () => {
  it("rejects an unknown shop", async () => {
    const res = await dispatch("POST", "/api/waitlist", {
      headers: { "CF-Connecting-IP": "203.0.113.20" },
      body: { shop_id: "no-such-shop", customer_name: "A", customer_email: "a@test.local" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects a service that belongs to another shop", async () => {
    const shopA = await seedShop("Waitlist A");
    const shopB = await seedShop("Waitlist B");
    const serviceB = await seedService(shopB);

    const res = await dispatch("POST", "/api/waitlist", {
      headers: { "CF-Connecting-IP": "203.0.113.21" },
      body: {
        shop_id: shopA,
        service_id: serviceB,
        customer_name: "A",
        customer_email: "a@test.local",
      },
    });
    expect(res.status).toBe(400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE shop_id = ?")
      .bind(shopA)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects an invalid email and an oversized name", async () => {
    const shop = await seedShop("Waitlist C");
    const badEmail = await dispatch("POST", "/api/waitlist", {
      headers: { "CF-Connecting-IP": "203.0.113.22" },
      body: { shop_id: shop, customer_name: "A", customer_email: "not-an-email" },
    });
    expect(badEmail.status).toBe(400);

    const bigName = await dispatch("POST", "/api/waitlist", {
      headers: { "CF-Connecting-IP": "203.0.113.22" },
      body: { shop_id: shop, customer_name: "x".repeat(121), customer_email: "a@test.local" },
    });
    expect(bigName.status).toBe(400);
  });

  it("accepts a valid entry, then rate-limits the 11th request from one IP", async () => {
    const shop = await seedShop("Waitlist D");
    const ip = "203.0.113.23";

    for (let i = 0; i < 10; i++) {
      const res = await dispatch("POST", "/api/waitlist", {
        headers: { "CF-Connecting-IP": ip },
        body: { shop_id: shop, customer_name: `Cust ${i}`, customer_email: `c${i}@test.local` },
      });
      expect(res.status).toBe(201);
    }

    const eleventh = await dispatch("POST", "/api/waitlist", {
      headers: { "CF-Connecting-IP": ip },
      body: { shop_id: shop, customer_name: "Cust 11", customer_email: "c11@test.local" },
    });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("GET /api/waitlist shop scoping (WS-7 fix: query param, not route param)", () => {
  it("lets a shop admin list their own waitlist and blocks another shop's", async () => {
    const shopA = await seedShop("WL Scope A");
    const shopB = await seedShop("WL Scope B");
    const adminA = await tokenFor(await seedUser("admin", shopA), "admin", shopA);

    const own = await dispatch("GET", `/api/waitlist?shop_id=${shopA}`, {
      headers: authHeaders(adminA),
    });
    expect(own.status).toBe(200);

    const other = await dispatch("GET", `/api/waitlist?shop_id=${shopB}`, {
      headers: authHeaders(adminA),
    });
    expect(other.status).toBe(403);
  });
});

// ─── Walk-in join ─────────────────────────────────────────────────────────────

describe("POST /api/walkin/:shopSlug/join hardening", () => {
  it("caps field lengths", async () => {
    const shop = await seedShop("Walkin A");
    const slug = await slugOf(shop);

    const res = await dispatch("POST", `/api/walkin/${slug}/join`, {
      headers: { "CF-Connecting-IP": "203.0.113.30" },
      body: { name: "Al", notes: "x".repeat(501) },
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits the 21st join from one IP", async () => {
    const shop = await seedShop("Walkin B");
    const slug = await slugOf(shop);
    const ip = "203.0.113.31";

    for (let i = 0; i < 20; i++) {
      const res = await dispatch("POST", `/api/walkin/${slug}/join`, {
        headers: { "CF-Connecting-IP": ip },
        body: { name: `Guest ${i}` },
      });
      expect(res.status).toBe(201);
    }
    const overflow = await dispatch("POST", `/api/walkin/${slug}/join`, {
      headers: { "CF-Connecting-IP": ip },
      body: { name: "Guest 21" },
    });
    expect(overflow.status).toBe(429);
  });
});

// ─── Reviews ──────────────────────────────────────────────────────────────────

describe("POST /api/shops/:shopId/reviews hardening", () => {
  it("rejects a review without a booking_id", async () => {
    const shop = await seedShop("Review A");
    const res = await dispatch("POST", `/api/shops/${shop}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.40" },
      body: { customer_name: "Anon", rating: 5, body: "Fake praise" },
    });
    expect(res.status).toBe(400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE shop_id = ?")
      .bind(shop)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a booking that belongs to another shop", async () => {
    const shopA = await seedShop("Review B");
    const shopB = await seedShop("Review C");
    const foreignBooking = await seedBooking(shopB, { date: "2020-01-10" });

    const res = await dispatch("POST", `/api/shops/${shopA}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.41" },
      body: { customer_name: "Anon", rating: 1, body: "Defamation", booking_id: foreignBooking },
    });
    expect(res.status).toBe(400);
  });

  it("rejects cancelled and not-yet-started bookings", async () => {
    const shop = await seedShop("Review D");
    const cancelled = await seedBooking(shop, { date: "2020-01-10", status: "cancelled" });
    const future = await seedBooking(shop, { date: "2099-01-10" });

    const c = await dispatch("POST", `/api/shops/${shop}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.42" },
      body: { customer_name: "A", rating: 3, body: "hm", booking_id: cancelled },
    });
    expect(c.status).toBe(400);

    const f = await dispatch("POST", `/api/shops/${shop}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.42" },
      body: { customer_name: "A", rating: 3, body: "hm", booking_id: future },
    });
    expect(f.status).toBe(400);
  });

  it("accepts one review for a past booking, then 409s the duplicate", async () => {
    const shop = await seedShop("Review E");
    const booking = await seedBooking(shop, { date: "2020-01-10" });

    const ok = await dispatch("POST", `/api/shops/${shop}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.43" },
      body: { customer_name: "Happy", rating: 5, body: "Great cut", booking_id: booking },
    });
    expect(ok.status).toBe(201);

    const dup = await dispatch("POST", `/api/shops/${shop}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.43" },
      body: { customer_name: "Happy", rating: 5, body: "Great cut again", booking_id: booking },
    });
    expect(dup.status).toBe(409);
  });

  it("rate-limits the 6th submission from one IP", async () => {
    const shop = await seedShop("Review F");
    const ip = "203.0.113.44";

    // Five attempts consume the window (invalid bookings still count — the
    // brake sits in front of validation), the sixth trips it.
    for (let i = 0; i < 5; i++) {
      const res = await dispatch("POST", `/api/shops/${shop}/reviews`, {
        headers: { "CF-Connecting-IP": ip },
        body: { customer_name: "Spam", rating: 5, body: "spam", booking_id: `nope-${i}` },
      });
      expect(res.status).toBe(400);
    }
    const sixth = await dispatch("POST", `/api/shops/${shop}/reviews`, {
      headers: { "CF-Connecting-IP": ip },
      body: { customer_name: "Spam", rating: 5, body: "spam", booking_id: "nope-6" },
    });
    expect(sixth.status).toBe(429);
  });

  it("caps review text at 2000 characters", async () => {
    const shop = await seedShop("Review G");
    const booking = await seedBooking(shop, { date: "2020-01-10" });
    const res = await dispatch("POST", `/api/shops/${shop}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.45" },
      body: { customer_name: "A", rating: 5, body: "x".repeat(2001), booking_id: booking },
    });
    expect(res.status).toBe(400);
  });
});
