import { Hono } from "hono";
import type { Bindings } from "../bindings.js";

// ─── /api/shops/:shopId/sales* → booking worker (WS-3 POS) ───────────────────
// The booking worker owns the sales spine (it holds the Stripe secrets and
// the money paths). Auth is enforced there (JWT forwarded via headers;
// developer or the shop's own admin/staff; void is admin-only) — this is a
// pure forward over the BOOKING service binding, like the connect proxy.

const salesProxy = new Hono<{ Bindings: Bindings }>();

function forward(c: { env: Bindings; req: { raw: Request; url: string; param: (k: string) => string | undefined } }, suffix: string) {
  const shopId = c.req.param("shopId")!;
  const search = new URL(c.req.url).search;
  return c.env.BOOKING.fetch(
    new Request(`https://booking/booking/shops/${shopId}/sales${suffix}${search}`, c.req.raw)
  );
}

salesProxy.all("/", (c) => forward(c, ""));
salesProxy.all("/:saleId", (c) => forward(c, `/${encodeURIComponent(c.req.param("saleId")!)}`));
salesProxy.all("/:saleId/void", (c) => forward(c, `/${encodeURIComponent(c.req.param("saleId")!)}/void`));

export default salesProxy;
