import { Hono } from "hono";
import Stripe from "stripe";
import type { D1Database } from "@cloudflare/workers-types";
import type { Bindings } from "../bindings.js";
import {
  getAllShops, getShopById, getShopBySlug,
  createShop, getNextShopNumber,
  createInvite,
  getShopSiteByShopId,
  updateShopStripeSession,
  insertGenerationJob,
  updateGenerationJob,
  getStaffByShop,
} from "../db/queries.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

const shops = new Hono<{ Bindings: Bindings }>();

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ─── GET /api/shops — list all shops (developer) ─────────────────────────────

const E2E_MOCK_SHOPS = [
  {
    id: "e2e-mock-unpaid",
    shop_number: 999,
    name: "E2E Unpaid Shop",
    slug: "e2e-unpaid-999",
    type: "beauty_parlor",
    owner_name: "",
    owner_email: "e2e@example.com",
    is_active: 0,
    status: "awaiting_payment",
    plan: "standard",
    has_site: null,
    stripe_payment_status: "unpaid",
    stripe_checkout_url: "https://checkout.stripe.com/e2e-mock-session",
    booking_count: 0,
    commission_total: 0,
  },
];

shops.get("/", authMiddleware, requireRole("developer"), async (c) => {
  // Playwright sets cookie → Remix forwards header; SSR bypasses page.route().
  if (c.req.header("X-E2E-Test-Mock-Stripe-List") === "1") {
    return c.json({ success: true, data: E2E_MOCK_SHOPS });
  }
  const allShops = await getAllShops(c.env.DB);
  return c.json({ success: true, data: allShops });
});

// ─── GET /api/shops/:shopId/theme — public theme lookup (KV-cached) ──────────

shops.get("/:shopId/theme", async (c) => {
  const { shopId } = c.req.param();
  // Accept both slug and ID
  const shop = await getShopBySlug(c.env.DB, shopId) ?? await getShopById(c.env.DB, shopId);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  // Try KV cache first
  const cached = await c.env.KV.get(`shop:theme:${shop.id}`);
  if (cached) {
    return c.json({ success: true, data: JSON.parse(cached) as unknown });
  }

  // Fall back to D1
  if (shop.ai_theme) {
    const theme = JSON.parse(shop.ai_theme) as unknown;
    // Back-fill KV cache
    await c.env.KV.put(`shop:theme:${shop.id}`, shop.ai_theme, {
      expirationTtl: 60 * 60 * 24 * 30,
    });
    return c.json({ success: true, data: theme });
  }

  return c.json({ success: false, error: "No theme generated for this shop" }, 404);
});

// ─── GET /api/shops/:shopId/site — public site lookup (KV-cached) ────────────

shops.get("/:shopId/site", async (c) => {
  const { shopId } = c.req.param();
  const shop = await getShopBySlug(c.env.DB, shopId) ?? await getShopById(c.env.DB, shopId);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const cached = await c.env.KV.get(`site:${shop.slug}`);
  if (cached) return c.json({ success: true, data: JSON.parse(cached) });

  const site = await getShopSiteByShopId(c.env.DB, shop.id);
  if (!site) return c.json({ success: false, error: "No site generated for this shop" }, 404);

  const data = {
    template: site.template,
    headline: site.headline,
    tagline: site.tagline,
    about: site.about,
    services: site.services_json ? JSON.parse(site.services_json) : [],
    color_primary: site.color_primary,
    color_accent: site.color_accent,
    font_heading: site.font_heading,
    font_body: site.font_body,
    hero_image_url: site.hero_image_url,
    logo_url: site.logo_url,
    catalog_images: site.catalog_images_json ? JSON.parse(site.catalog_images_json) : [],
    seo_title: (site as { seo_title?: string | null }).seo_title ?? null,
    seo_description: (site as { seo_description?: string | null }).seo_description ?? null,
  };

  await c.env.KV.put(`site:${shop.slug}`, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 });
  return c.json({ success: true, data });
});

// ─── GET /api/shops/:shopId/booking-staff — public staff list for customer booking (no emails) ─

shops.get("/:shopId/booking-staff", async (c) => {
  const shopIdParam = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, shopIdParam)) ?? (await getShopById(c.env.DB, shopIdParam));
  if (!shop) {
    console.log("[booking-staff][GET] shop not found param=", shopIdParam);
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  const members = await getStaffByShop(c.env.DB, shop.id);
  const data = members.map((m) => ({
    id: m.id,
    display_name: m.display_name,
    bio: m.bio ?? undefined,
  }));

  console.log(
    "[booking-staff][GET] param=",
    shopIdParam,
    "resolved_shop_id=",
    shop.id,
    "shop_slug=",
    shop.slug,
    "staff_active_count=",
    data.length
  );

  return c.json({ success: true, data });
});

// ─── GET /api/shops/:shopId/reviews — public reviews (best-effort; [] on error) ─────────

shops.get("/:shopId/reviews", async (c) => {
  try {
    const shopIdParam = c.req.param("shopId");
    const shop =
      (await getShopBySlug(c.env.DB, shopIdParam)) ?? (await getShopById(c.env.DB, shopIdParam));
    if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

    const { results } = await c.env.DB
      .prepare(
        "SELECT id, customer_name, rating, body, created_at FROM reviews WHERE shop_id = ? ORDER BY created_at DESC LIMIT 20"
      )
      .bind(shop.id)
      .all<{ id: string; customer_name: string; rating: number; body: string; created_at: string }>();

    const data = (results ?? []).map((r) => ({
      id: r.id,
      customer_name: r.customer_name,
      rating: r.rating,
      body: r.body,
      created_at: r.created_at,
    }));
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

// ─── GET /api/shops/:shopId/settings — public shop settings (best-effort; {} on error) ───

shops.get("/:shopId/settings", async (c) => {
  try {
    const shopIdParam = c.req.param("shopId");
    const shop =
      (await getShopBySlug(c.env.DB, shopIdParam)) ?? (await getShopById(c.env.DB, shopIdParam));
    if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

    const row = await c.env.DB
      .prepare("SELECT * FROM shop_settings WHERE shop_id = ? LIMIT 1")
      .bind(shop.id)
      .first<Record<string, unknown>>();

    if (!row) return c.json({ success: true, data: {} });

    const num = (v: unknown): number | undefined =>
      typeof v === "number" && !Number.isNaN(v) ? v : undefined;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.length > 0 ? v : undefined;
    const flag = (v: unknown): boolean | undefined =>
      v === 1 || v === true ? true : v === 0 || v === false ? false : undefined;

    const data = {
      phone: str(row.phone),
      address: str(row.address),
      lat: num(row.lat),
      lng: num(row.lng),
      hours_json: str(row.hours_json),
      instagram_url: str(row.instagram_url),
      facebook_url: str(row.facebook_url),
      tiktok_url: str(row.tiktok_url),
      twitter_url: str(row.twitter_url),
      youtube_url: str(row.youtube_url),
      whatsapp_url: str(row.whatsapp_url),
      linkedin_url: str(row.linkedin_url),
      show_instagram: flag(row.show_instagram),
      show_facebook: flag(row.show_facebook),
      show_tiktok: flag(row.show_tiktok),
      show_twitter: flag(row.show_twitter),
      show_youtube: flag(row.show_youtube),
      show_whatsapp: flag(row.show_whatsapp),
      show_linkedin: flag(row.show_linkedin),
    };
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: true, data: {} });
  }
});

// ─── GET /api/shops/:shopId/generation-prefs — developer/admin: last saved inputs for regenerate-site ───

shops.get("/:shopId/generation-prefs", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const site = await getShopSiteByShopId(c.env.DB, shop.id);
  if (!site) {
    return c.json({
      success: true,
      data: {
        template: "minimal",
        design_notes: null as string | null,
        color_primary: null as string | null,
        color_accent: null as string | null,
      },
    });
  }

  const row = site as typeof site & {
    design_notes?: string | null;
    owner_color_primary?: string | null;
    owner_color_accent?: string | null;
  };

  return c.json({
    success: true,
    data: {
      template: site.template,
      design_notes: row.design_notes ?? null,
      color_primary: row.owner_color_primary || site.color_primary || null,
      color_accent: row.owner_color_accent || site.color_accent || null,
    },
  });
});

// ─── POST /api/shops/:shopId/generate-site — AI site generation (developer or admin) ───

shops.post("/:shopId/generate-site", authMiddleware, async (c) => {
  const user = getUser(c);
  const { shopId } = c.req.param();

  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shopId)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const shop = await getShopById(c.env.DB, shopId) ?? await getShopBySlug(c.env.DB, shopId);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const contentType = c.req.header("Content-Type") ?? "";
  let body: {
    template?: string;
    color_primary?: string;
    color_accent?: string;
    design_notes?: string;
    logo_file?: File;
  } = {};

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    body = {
      template: form.template?.toString(),
      color_primary: form.color_primary?.toString(),
      color_accent: form.color_accent?.toString(),
      design_notes: form.design_notes?.toString(),
      logo_file: form.logo_file instanceof File ? form.logo_file : undefined,
    };
  } else {
    const json = await c.req.json<typeof body>().catch(() => ({}));
    body = json;
  }

  const validTemplates = ["minimal", "luxury", "vibrant", "editorial", "classic", "fresh"];
  const template =
    body.template?.trim() && validTemplates.includes(body.template) ? body.template : "minimal";

  let jobId: string | null = null;
  const nowKv = () =>
    JSON.stringify({
      status: "queued",
      stage: "research",
      shopSlug: shop.slug,
    });

  try {
    jobId = crypto.randomUUID();
    await insertGenerationJob(c.env.DB, {
      id: jobId,
      shop_id: shop.id,
      status: "queued",
      stage: "research",
    });
    await c.env.KV.put(`job:${jobId}`, nowKv(), { expirationTtl: 60 * 60 * 48 });

    if (body.logo_file && body.logo_file.size > 0) {
      const buf = await body.logo_file.arrayBuffer();
      const ext = body.logo_file.name.match(/\.(png|jpg|jpeg|svg|webp)$/i)?.[1] ?? "png";
      const contentType =
        body.logo_file.type ||
        (ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png");
      await c.env.ASSETS.put(`shops/${shop.slug}/logo-upload`, buf, {
        httpMetadata: { contentType },
      });
    }

    const queuePayload = {
      jobId,
      shopId: shop.id,
      shopName: shop.name,
      shopType: shop.type,
      shopSlug: shop.slug,
      template,
      color_primary: body.color_primary?.trim() || undefined,
      color_accent: body.color_accent?.trim() || undefined,
      design_notes: body.design_notes?.trim() || undefined,
    };

    if (!c.env.site_research_queue) {
      await updateGenerationJob(c.env.DB, jobId, {
        status: "failed",
        error: "site_research_queue binding not configured",
      });
      await c.env.KV.put(
        `job:${jobId}`,
        JSON.stringify({
          status: "failed",
          stage: "research",
          shopSlug: shop.slug,
          error: "site_research_queue binding not configured",
        }),
        { expirationTtl: 60 * 60 * 48 }
      );
      return c.json({ success: false, error: "Site generation queue is not configured" }, 503);
    }

    await c.env.site_research_queue.send(queuePayload);
    return c.json(
      { success: true, data: { jobId, message: "Site generation started" } },
      202
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Site generation failed";
    if (jobId) {
      try {
        await updateGenerationJob(c.env.DB, jobId, { status: "failed", error: msg });
        await c.env.KV.put(
          `job:${jobId}`,
          JSON.stringify({
            status: "failed",
            stage: "research",
            shopSlug: shop.slug,
            error: msg,
          }),
          { expirationTtl: 60 * 60 * 48 }
        );
      } catch {
        /* best effort */
      }
    }
    return c.json({ success: false, error: msg }, 400);
  }
});

// ─── GET /api/shops/:shopId — single shop (public) ───────────────────────────

shops.get("/:shopId", async (c) => {
  const { shopId } = c.req.param();
  // Try by slug first (for customer-facing URLs), fall back to ID
  const shop = await getShopBySlug(c.env.DB, shopId) ?? await getShopById(c.env.DB, shopId);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const safe = {
    id: shop.id,
    shop_number: shop.shop_number,
    slug: shop.slug,
    name: shop.name,
    type: shop.type,
    phone: shop.phone,
    commission_rate: shop.commission_rate,
    is_active: shop.is_active,
    created_at: shop.created_at,
    ...(shop.ai_theme ? { ai_theme: JSON.parse(shop.ai_theme) } : {}),
  };
  return c.json({ success: true, data: safe });
});

// ─── POST /api/shops — onboard new shop (developer only) ─────────────────────
// Accepts: name, owner_email, slug? (auto-generated if omitted), type?, plan?
// When STRIPE_SECRET_KEY is set: creates Stripe Checkout session, shop status awaiting_payment,
//   invite active=0. Returns { shop, checkout_url }.
// When STRIPE_SECRET_KEY is not set: legacy flow — status pending, invite active, returns invite_token.

async function markContactOnboarded(
  db: D1Database,
  shopId: string,
  contactEmail: string
): Promise<void> {
  const email = contactEmail.trim().toLowerCase();
  await db
    .prepare(
      `UPDATE contacts SET onboarded_at = datetime('now'), shop_id = ? WHERE LOWER(email) = ? AND onboarded_at IS NULL`
    )
    .bind(shopId, email)
    .run();
}

shops.post("/", authMiddleware, requireRole("developer"), async (c) => {
  const body = await c.req.json<{
    name?: string;
    owner_email?: string;
    slug?: string;
    type?: string;
    plan?: string;
    commission_rate?: number;
    /** When set (e.g. enquiry flow), links created shop to contacts row by email. */
    contact_email?: string;
  }>();

  if (!body.name?.trim() || !body.owner_email?.trim()) {
    return c.json({ success: false, error: "name and owner_email are required" }, 400);
  }

  const shopNumber = await getNextShopNumber(c.env.DB);
  const baseSlug = body.slug?.trim() ? toSlug(body.slug.trim()) : toSlug(body.name.trim());
  const slug = `${baseSlug}-${String(shopNumber).padStart(3, "0")}`;

  const existing = await getShopBySlug(c.env.DB, slug);
  if (existing) return c.json({ success: false, error: "A shop with this slug already exists" }, 409);

  const shopId = crypto.randomUUID();
  const inviteId = crypto.randomUUID();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // E2E: force legacy invite flow (active invite, no Checkout) when Remix sends mock header.
  const useStripe = !!c.env.STRIPE_SECRET_KEY && c.req.header("X-E2E-Test-Mock") !== "1";

  if (useStripe) {
    await createShop(c.env.DB, {
      id: shopId,
      shop_number: shopNumber,
      slug,
      name: body.name.trim(),
      owner_email: body.owner_email.trim().toLowerCase(),
      type: body.type ?? "beauty_parlor",
      plan: body.plan ?? "standard",
      status: "awaiting_payment",
      stripe_payment_status: "unpaid",
    });

    await createInvite(c.env.DB, {
      id: inviteId,
      email: body.owner_email.trim().toLowerCase(),
      shop_id: shopId,
      role: "admin",
      token,
      expires_at: expiresAt,
      active: 0,
    });

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY!, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: 10000,
            product_data: {
              name: "Pivot Parlor Setup Fee",
              description: `One-time setup fee for ${body.name.trim()}`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `https://pivotparlor.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: "https://pivotparlor.com/onboarding/payment-cancelled",
      metadata: { shop_id: shopId, invite_id: inviteId },
    });

    await updateShopStripeSession(c.env.DB, shopId, session.id, session.url);

    if (body.contact_email?.trim()) {
      try {
        await markContactOnboarded(c.env.DB, shopId, body.contact_email);
      } catch (e) {
        console.error("[shops POST] markContactOnboarded failed", e);
      }
    }

    return c.json({
      success: true,
      data: {
        shop: { id: shopId, slug, name: body.name.trim() },
        checkout_url: session.url,
      },
    }, 201);
  }

  // Legacy flow (no Stripe)
  await createShop(c.env.DB, {
    id: shopId,
    shop_number: shopNumber,
    slug,
    name: body.name.trim(),
    owner_email: body.owner_email.trim().toLowerCase(),
    type: body.type ?? "beauty_parlor",
    plan: body.plan ?? "standard",
    status: "pending",
  });

  await createInvite(c.env.DB, {
    id: inviteId,
    email: body.owner_email.trim().toLowerCase(),
    shop_id: shopId,
    role: "admin",
    token,
    expires_at: expiresAt,
  });

  if (body.contact_email?.trim()) {
    try {
      await markContactOnboarded(c.env.DB, shopId, body.contact_email);
    } catch (e) {
      console.error("[shops POST] markContactOnboarded failed", e);
    }
  }

  return c.json({
    success: true,
    data: {
      shop: { id: shopId, slug, name: body.name.trim() },
      invite_token: token,
    },
  }, 201);
});

// ─── PATCH /api/shops/:shopId — update shop (developer/admin) ────────────────

shops.patch("/:shopId", authMiddleware, async (c) => {
  const user = getUser(c);
  const { shopId } = c.req.param();

  if (user.role !== "developer" && user.shop_id !== shopId) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    phone?: string;
    is_active?: number;
  }>();

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); vals.push(body.name); }
  if (body.phone !== undefined) { sets.push("phone = ?"); vals.push(body.phone); }
  if (body.is_active !== undefined) { sets.push("is_active = ?"); vals.push(body.is_active); }

  if (sets.length > 0) {
    vals.push(shopId);
    await c.env.DB.prepare(`UPDATE shops SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  const shop = await getShopById(c.env.DB, shopId);
  return c.json({ success: true, data: shop });
});

export default shops;
