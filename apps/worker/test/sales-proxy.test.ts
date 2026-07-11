/**
 * WS-3: /api/shops/:shopId/sales* is a pure forward to the booking worker's
 * BOOKING service binding (stubbed in vitest.config.mts to echo the request).
 * Auth/RBAC for sales is enforced in the booking worker's own suite.
 */
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

type Echo = {
  success: boolean;
  data: { stub: string; url: string; method: string; body: string | null };
};

describe("sales proxy", () => {
  it("forwards a sale creation with body and query intact", async () => {
    const res = await dispatch("POST", "/api/shops/shop-1/sales?debug=1", {
      body: { tender: "cash", items: [] },
    });
    expect(res.status).toBe(201);
    const echo = (await res.json()) as Echo;
    expect(echo.data.stub).toBe("BOOKING");
    expect(echo.data.url).toBe("https://booking/booking/shops/shop-1/sales?debug=1");
    expect(JSON.parse(echo.data.body ?? "{}")).toMatchObject({ tender: "cash" });
  });

  it("forwards sale reads and voids to the right paths", async () => {
    const get = await dispatch("GET", "/api/shops/shop-1/sales/sale-9");
    expect(((await get.json()) as Echo).data.url).toBe(
      "https://booking/booking/shops/shop-1/sales/sale-9"
    );

    const voided = await dispatch("POST", "/api/shops/shop-1/sales/sale-9/void", { body: {} });
    expect(((await voided.json()) as Echo).data.url).toBe(
      "https://booking/booking/shops/shop-1/sales/sale-9/void"
    );
  });
});
