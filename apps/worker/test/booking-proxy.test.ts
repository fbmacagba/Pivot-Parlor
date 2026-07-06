import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

/**
 * WS-1: public booking + slots are proxied to the booking worker over the
 * BOOKING service binding (stubbed in vitest.config.mts to echo the request).
 * These tests pin the forwarding contract — URL rewrite, method, query
 * string, JSON body, and the CF-Connecting-IP header the booking worker's
 * rate limiter keys on. The behaviour behind the binding is covered by
 * apps/workers/booking's own suite.
 */

interface EchoBody {
  success: boolean;
  data: { stub: string; url: string; method: string; body: string | null; ip: string | null };
}

describe("public booking proxy (/api/bookings)", () => {
  it("forwards POST body and client IP to /public/bookings", async () => {
    const payload = { shop_slug: "some-shop", staff_id: "any", customer_name: "Casey" };
    const res = await dispatch("POST", "/api/bookings", {
      body: payload,
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    expect(res.status).toBe(201);
    const echo = (await res.json()) as EchoBody;
    expect(echo.data.stub).toBe("BOOKING");
    expect(echo.data.url).toBe("https://booking/public/bookings");
    expect(echo.data.method).toBe("POST");
    expect(JSON.parse(echo.data.body!)).toEqual(payload);
    expect(echo.data.ip).toBe("203.0.113.9");
  });
});

describe("slots proxy (/api/shops/:shopId/slots)", () => {
  it("forwards the shop id and query string to /public/shops/:shopId/slots", async () => {
    const res = await dispatch(
      "GET",
      "/api/shops/shop-123/slots?date=2099-06-15&service_id=svc-1&staff_id=st-1"
    );
    expect(res.status).toBe(200);
    const echo = (await res.json()) as EchoBody;
    expect(echo.data.url).toBe(
      "https://booking/public/shops/shop-123/slots?date=2099-06-15&service_id=svc-1&staff_id=st-1"
    );
    expect(echo.data.method).toBe("GET");
  });
});
