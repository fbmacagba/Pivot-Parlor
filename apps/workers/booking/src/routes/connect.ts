/**
 * Stripe Connect (Express) onboarding — WS-2.
 *
 * Mounted under /booking/shops/:shopId (JWT + shop access enforced upstream);
 * both routes additionally require admin or developer — staff must not manage
 * the shop's payout account. The account.updated webhook (stripe-webhook.ts)
 * is what flips shops.stripe_connect_onboarded; the status route also polls
 * Stripe directly so a missed webhook cannot wedge onboarding forever.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { getUser } from "../middleware/auth.js";
import { shopExists } from "../middleware/shop-access.js";
import { createConnectAccount, createAccountLink, getAccount } from "../lib/stripe.js";
import { reportError } from "../services/report-error.js";

const r = new Hono<{ Bindings: Env }>();

function requireAdmin(c: Context<{ Bindings: Env }>): boolean {
  const user = getUser(c);
  return user.role === "admin" || user.role === "developer";
}

// POST /:shopId/connect/onboard { return_url, refresh_url }
// Creates the Express account on first call (persisting the id immediately so
// a retry reuses it), then returns a fresh account-link URL to redirect to.
r.post("/:shopId/connect/onboard", async (c) => {
  const shopId = c.req.param("shopId");
  if (!requireAdmin(c)) {
    return c.json({ success: false, error: "Admin role required" }, 403);
  }
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  let body: { return_url?: string; refresh_url?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const returnUrl = body.return_url?.trim();
  const refreshUrl = body.refresh_url?.trim();
  const isHttp = (u: string | undefined): u is string =>
    !!u && (u.startsWith("https://") || u.startsWith("http://localhost"));
  if (!isHttp(returnUrl) || !isHttp(refreshUrl)) {
    return c.json({ success: false, error: "return_url and refresh_url must be https URLs" }, 400);
  }

  const shop = await c.env.DB
    .prepare("SELECT stripe_connect_account_id, owner_email FROM shops WHERE id = ? LIMIT 1")
    .bind(shopId)
    .first<{ stripe_connect_account_id: string | null; owner_email: string }>();

  let accountId = shop?.stripe_connect_account_id?.trim() || null;
  if (!accountId) {
    const account = await createConnectAccount({
      secret: c.env.STRIPE_SECRET_KEY,
      email: shop?.owner_email ?? "",
      shopId,
      idempotencyKey: `connect-account:${shopId}`,
    });
    accountId = account.id;
    await c.env.DB
      .prepare("UPDATE shops SET stripe_connect_account_id = ? WHERE id = ?")
      .bind(accountId, shopId)
      .run();
  }

  const link = await createAccountLink({
    secret: c.env.STRIPE_SECRET_KEY,
    account: accountId,
    returnUrl,
    refreshUrl,
  });

  return c.json({ success: true, data: { account_id: accountId, url: link.url } });
});

// GET /:shopId/connect/status
// Reads the persisted columns and, when an account exists but is not yet
// marked onboarded, polls Stripe and syncs the flag (webhook backstop).
r.get("/:shopId/connect/status", async (c) => {
  const shopId = c.req.param("shopId");
  if (!requireAdmin(c)) {
    return c.json({ success: false, error: "Admin role required" }, 403);
  }
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  const shop = await c.env.DB
    .prepare("SELECT stripe_connect_account_id, stripe_connect_onboarded FROM shops WHERE id = ? LIMIT 1")
    .bind(shopId)
    .first<{ stripe_connect_account_id: string | null; stripe_connect_onboarded: number | null }>();

  const accountId = shop?.stripe_connect_account_id?.trim() || null;
  let onboarded = Number(shop?.stripe_connect_onboarded ?? 0) === 1;
  let chargesEnabled: boolean | null = null;
  let payoutsEnabled: boolean | null = null;

  if (accountId && !onboarded) {
    try {
      const acct = await getAccount(c.env.STRIPE_SECRET_KEY, accountId);
      chargesEnabled = acct.charges_enabled;
      payoutsEnabled = acct.payouts_enabled;
      if (acct.charges_enabled && acct.details_submitted) {
        onboarded = true;
        await c.env.DB
          .prepare("UPDATE shops SET stripe_connect_onboarded = 1 WHERE id = ?")
          .bind(shopId)
          .run();
      }
    } catch (err) {
      // Non-fatal: report and fall back to the persisted columns.
      reportError("connect.status_poll", err, { shopId, accountId });
    }
  }

  return c.json({
    success: true,
    data: {
      account_id: accountId,
      onboarded,
      charges_enabled: chargesEnabled,
      payouts_enabled: payoutsEnabled,
    },
  });
});

export default r;
