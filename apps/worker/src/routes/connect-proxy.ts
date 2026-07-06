import { Hono } from "hono";
import type { Bindings } from "../bindings.js";

// ─── /api/shops/:shopId/connect/* → booking worker (WS-2) ────────────────────
// The booking worker owns Stripe Connect onboarding. Auth is enforced there
// (JWT forwarded via headers; admin/developer only) — this is a pure forward
// over the BOOKING service binding, like the public booking proxy.

const connectProxy = new Hono<{ Bindings: Bindings }>();

connectProxy.all("/:action", (c) => {
  const shopId = c.req.param("shopId")!;
  const action = c.req.param("action");
  const search = new URL(c.req.url).search;
  return c.env.BOOKING.fetch(
    new Request(
      `https://booking/booking/shops/${shopId}/connect/${action}${search}`,
      c.req.raw
    )
  );
});

export default connectProxy;
