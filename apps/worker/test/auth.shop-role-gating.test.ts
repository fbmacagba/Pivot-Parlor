import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

/**
 * SEC-2 / ARCH-1 regression. Shop-scoped mutations must be admin-only; staff
 * keep operational + read access. Before the fix, requireShop() authorized on a
 * shop_id match with no role check, so a staff member could edit shop settings,
 * manage other staff, edit services, and edit schedules.
 */
describe("SEC-2: shop role-gating", () => {
  it("staff CANNOT edit shop settings (PATCH /api/shops/:shopId)", async () => {
    const shop = await seedShop("Shop A");
    const token = await tokenFor(await seedUser("staff", shop), "staff", shop);
    const res = await dispatch("PATCH", `/api/shops/${shop}`, {
      headers: authHeaders(token),
      body: { name: "Hacked Name", is_active: 0 },
    });
    expect(res.status).toBe(403);
  });

  it("staff CANNOT create staff (POST /api/shops/:shopId/staff)", async () => {
    const shop = await seedShop("Shop B");
    const token = await tokenFor(await seedUser("staff", shop), "staff", shop);
    const res = await dispatch("POST", `/api/shops/${shop}/staff`, {
      headers: authHeaders(token),
      body: { display_name: "X", email: "x@test.local" },
    });
    expect(res.status).toBe(403);
  });

  it("staff CANNOT create a service (POST /api/shops/:shopId/services)", async () => {
    const shop = await seedShop("Shop C");
    const token = await tokenFor(await seedUser("staff", shop), "staff", shop);
    const res = await dispatch("POST", `/api/shops/${shop}/services`, {
      headers: authHeaders(token),
      body: { name: "Cut", duration_min: 30, price_pence: 2000 },
    });
    expect(res.status).toBe(403);
  });

  it("staff CANNOT edit schedules (PUT /api/shops/:shopId/schedule)", async () => {
    const shop = await seedShop("Shop D");
    const token = await tokenFor(await seedUser("staff", shop), "staff", shop);
    const res = await dispatch("PUT", `/api/shops/${shop}/schedule`, {
      headers: authHeaders(token),
      body: { entries: [{ staff_id: "x", day_of_week: 0, start_time: "09:00", end_time: "17:00" }] },
    });
    expect(res.status).toBe(403);
  });

  it("admin CAN edit shop settings and create a service", async () => {
    const shop = await seedShop("Shop E");
    const token = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const patch = await dispatch("PATCH", `/api/shops/${shop}`, {
      headers: authHeaders(token),
      body: { name: "New Name" },
    });
    expect(patch.status).toBe(200);
    const svc = await dispatch("POST", `/api/shops/${shop}/services`, {
      headers: authHeaders(token),
      body: { name: "Cut", duration_min: 30, price_pence: 2000 },
    });
    expect(svc.status).toBe(201);
  });

  it("staff CAN access operational bookings and read the staff list", async () => {
    const shop = await seedShop("Shop F");
    const token = await tokenFor(await seedUser("staff", shop), "staff", shop);
    const bookings = await dispatch("GET", `/api/shops/${shop}/bookings`, { headers: authHeaders(token) });
    expect(bookings.status).toBe(200);
    const staffList = await dispatch("GET", `/api/shops/${shop}/staff`, { headers: authHeaders(token) });
    expect(staffList.status).toBe(200);
  });

  it("an admin of another shop cannot edit this shop (scoping preserved)", async () => {
    const shopA = await seedShop("Shop G");
    const shopB = await seedShop("Shop H");
    const tokenAdminB = await tokenFor(await seedUser("admin", shopB), "admin", shopB);
    const res = await dispatch("PATCH", `/api/shops/${shopA}`, {
      headers: authHeaders(tokenAdminB),
      body: { name: "Cross-tenant" },
    });
    expect(res.status).toBe(403);
  });
});
