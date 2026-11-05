import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedService, seedScheduleDay } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";

describe("portfolio demo booking boundary", () => {
  it("refuses original tenant ID and slug before bookings or payments can be created", async () => {
    const shopId = await seedShop("Portfolio example");
    const slug = "ferdyms-barber-shop-014";
    await env.DB.prepare("UPDATE shops SET slug = ? WHERE id = ?")
      .bind(slug, shopId)
      .run();
    const staffId = await seedStaff(shopId);
    const serviceId = await seedService(shopId);
    for (let day = 0; day < 7; day++)
      await seedScheduleDay(shopId, staffId, day);
    const slots = await getAvailableSlots(
      shopId,
      staffId,
      "2099-06-15",
      30,
      env.DB,
      env.KV,
    );
    const start = slots.find((s) => s.is_available)!.start_time;
    for (const identity of [{ shop_id: shopId }, { shop_slug: slug }]) {
      const response = await dispatch("POST", "/public/bookings", {
        body: {
          ...identity,
          staff_id: staffId,
          service_id: serviceId,
          customer_name: "Sample guest",
          customer_email: "guest@example.com",
          start_time: start,
          date: "2099-06-15",
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: expect.stringContaining("demonstration"),
      });
    }
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM bookings WHERE shop_id = ?",
      )
        .bind(shopId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
