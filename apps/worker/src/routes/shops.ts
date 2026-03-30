import { Hono } from "hono";
import Stripe from "stripe";
import type { D1Database } from "@cloudflare/workers-types";
import type { Bindings } from "../bindings.js";
import {
  getAllShops,
  getShopById,
  getShopBySlug,
  createShop,
  createShopSite,
  getNextShopNumber,
  createInvite,
  getShopSiteByShopId,
  updateShopStripeSession,
  insertGenerationJob,
  updateGenerationJob,
  getStaffByShop,
  getServicesByShop,
  updateShopSiteHeroImageUrl,
  updateShopSiteLogoUrl,
  updateShopSiteWebsiteStatus,
  type DBService,
} from "../db/queries.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { generateOpenRouterImageBuffer } from "../services/openrouter-image-generation.js";

const shops = new Hono<{ Bindings: Bindings }>();

/** Matches `ResearchQueueMessage.services` in apps/workers/research. */
type SiteResearchQueueService = { name: string; price_gbp: number; duration_min: number };

function mapDbServiceToResearchQueue(row: DBService): SiteResearchQueueService {
  return { name: row.name, price_gbp: row.price, duration_min: row.duration_min };
}

function servicesFromShopSitesJson(servicesJson: string | null | undefined): SiteResearchQueueService[] {
  if (!servicesJson) return [];
  try {
    const arr = JSON.parse(servicesJson) as unknown[];
    if (!Array.isArray(arr)) return [];
    const out: SiteResearchQueueService[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.name !== "string" || !o.name.trim()) continue;
      const price_gbp =
        typeof o.price_gbp === "number" && !Number.isNaN(o.price_gbp)
          ? o.price_gbp
          : typeof o.price === "number" && !Number.isNaN(o.price)
            ? o.price
            : 25;
      const duration_min =
        typeof o.duration_min === "number" && !Number.isNaN(o.duration_min)
          ? o.duration_min
          : typeof o.duration_minutes === "number" && !Number.isNaN(o.duration_minutes)
            ? o.duration_minutes
            : 30;
      out.push({ name: o.name.trim(), price_gbp, duration_min });
    }
    return out;
  } catch {
    return [];
  }
}

async function buildSiteResearchQueueServices(
  db: D1Database,
  shopId: string
): Promise<SiteResearchQueueService[]> {
  const dbRows = await getServicesByShop(db, shopId);
  let services = dbRows.map(mapDbServiceToResearchQueue);

  if (services.length < 2) {
    const site = await getShopSiteByShopId(db, shopId);
    const fromSite = servicesFromShopSitesJson(site?.services_json ?? null);
    const seen = new Set(services.map((s) => s.name.toLowerCase()));
    for (const s of fromSite) {
      if (services.length >= 2) break;
      const k = s.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      services.push(s);
    }
  }

  let n = 0;
  while (services.length < 2) {
    n += 1;
    services.push({
      name: `Default service ${n}`,
      price_gbp: 25,
      duration_min: 30,
    });
  }

  return services;
}

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

  const site = await getShopSiteByShopId(c.env.DB, shop.id);
  if (!site) return c.json({ success: false, error: "No site generated for this shop" }, 404);

  const freshServices = site.services_json ? JSON.parse(site.services_json) : [];

  const websiteStatus = (site as { website_status?: string | null }).website_status ?? "draft";

  const cached = await c.env.KV.get(`site:${shop.slug}`);
  if (cached) {
    try {
      const data = JSON.parse(cached) as Record<string, unknown>;
      data.services = freshServices;
      data.website_status = websiteStatus;
      // Always refresh image URLs from D1 — KV snapshot can be stale after save-image / pipeline
      data.hero_image_url = site.hero_image_url;
      data.logo_url = site.logo_url;
      return c.json({ success: true, data });
    } catch {
      /* fall through to rebuild from D1 */
    }
  }

  const data = {
    template: site.template,
    headline: site.headline,
    tagline: site.tagline,
    about: site.about,
    services: freshServices,
    color_primary: site.color_primary,
    color_accent: site.color_accent,
    font_heading: site.font_heading,
    font_body: site.font_body,
    hero_image_url: site.hero_image_url,
    logo_url: site.logo_url,
    catalog_images: site.catalog_images_json ? JSON.parse(site.catalog_images_json) : [],
    seo_title: (site as { seo_title?: string | null }).seo_title ?? null,
    seo_description: (site as { seo_description?: string | null }).seo_description ?? null,
    website_status: websiteStatus,
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

// ─── GET /api/shops/:shopId/stripe-status — admin: get payment status + checkout URL ──

shops.get("/:shopId/stripe-status", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop = (await getShopById(c.env.DB, param)) ?? (await getShopBySlug(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const row = await c.env.DB
    .prepare("SELECT stripe_payment_status, stripe_checkout_url, name, slug FROM shops WHERE id = ? LIMIT 1")
    .bind(shop.id)
    .first<{ stripe_payment_status: string | null; stripe_checkout_url: string | null; name: string; slug: string }>();

  return c.json({ success: true, data: row });
});

// ─── POST /api/shops/:shopId/reviews — public review submission ──────────────

shops.post("/:shopId/reviews", async (c) => {
  try {
    const shopIdParam = c.req.param("shopId");
    const shop =
      (await getShopBySlug(c.env.DB, shopIdParam)) ?? (await getShopById(c.env.DB, shopIdParam));
    if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

    const body = await c.req.json<{
      customer_name?: string;
      rating?: number;
      body?: string;
      booking_id?: string;
    }>();

    const name = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    const rating = typeof body.rating === "number" ? body.rating : 0;
    const bookingId = typeof body.booking_id === "string" ? body.booking_id.trim() : null;

    if (!name) return c.json({ success: false, error: "Name is required" }, 400);
    if (!text) return c.json({ success: false, error: "Review text is required" }, 400);
    if (rating < 1 || rating > 5) return c.json({ success: false, error: "Rating must be 1–5" }, 400);

    // Verify booking belongs to this shop (if provided)
    if (bookingId) {
      const booking = await c.env.DB
        .prepare("SELECT id FROM bookings WHERE id = ? AND shop_id = ? LIMIT 1")
        .bind(bookingId, shop.id)
        .first<{ id: string }>();
      if (!booking) return c.json({ success: false, error: "Invalid booking" }, 400);

      // Check for duplicate review
      const existing = await c.env.DB
        .prepare("SELECT id FROM reviews WHERE booking_id = ? LIMIT 1")
        .bind(bookingId)
        .first<{ id: string }>();
      if (existing) return c.json({ success: false, error: "Review already submitted for this booking" }, 409);
    }

    const id = crypto.randomUUID();
    await c.env.DB
      .prepare(
        "INSERT INTO reviews (id, shop_id, customer_name, rating, body, booking_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(id, shop.id, name, rating, text, bookingId)
      .run();

    return c.json({ success: true, data: { id } }, 201);
  } catch (e) {
    console.error("[reviews] POST failed", e);
    return c.json({ success: false, error: "Failed to submit review" }, 500);
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
      booking_enabled: flag(row.booking_enabled) === false ? false : true,
      booking_confirmation_email: flag(row.booking_confirmation_email) !== false,
      booking_reminder_email: flag(row.booking_reminder_email) !== false,
      reminder_hours_before: typeof row.reminder_hours_before === "number" ? row.reminder_hours_before : 24,
      review_request_email: flag(row.review_request_email) !== false,
    };
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: true, data: {} });
  }
});

const SHOP_SETTINGS_PATCH_FIELDS = [
  "phone",
  "address",
  "lat",
  "lng",
  "hours_json",
  "instagram_url",
  "facebook_url",
  "tiktok_url",
  "twitter_url",
  "youtube_url",
  "whatsapp_url",
  "linkedin_url",
  "show_instagram",
  "show_facebook",
  "show_tiktok",
  "show_twitter",
  "show_youtube",
  "show_whatsapp",
  "show_linkedin",
  "booking_confirmation_email",
  "booking_reminder_email",
  "reminder_hours_before",
  "review_request_email",
] as const;

type ShopSettingsPatchField = (typeof SHOP_SETTINGS_PATCH_FIELDS)[number];

function coerceShopSettingValue(field: ShopSettingsPatchField, raw: unknown): string | number | null {
  if (field === "lat" || field === "lng") {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(String(raw));
    return Number.isFinite(n) ? n : null;
  }
  if (field === "reminder_hours_before") {
    if (raw === null || raw === undefined || raw === "") return 24;
    const n = typeof raw === "number" ? raw : Number(String(raw));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 72) : 24;
  }
  if (field === "booking_confirmation_email" || field === "booking_reminder_email" || field === "review_request_email") {
    return raw === true || raw === 1 || raw === "1" ? 1 : 0;
  }
  if (field.startsWith("show_")) {
    if (raw === true || raw === 1 || raw === "1" || raw === "true" || raw === "on") return 1;
    return 0;
  }
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

// ─── PATCH /api/shops/:shopId/settings — admin/developer: upsert shop_settings (D1) ───

shops.patch("/:shopId/settings", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  const patchKeys = SHOP_SETTINGS_PATCH_FIELDS.filter((f) =>
    Object.prototype.hasOwnProperty.call(body, f)
  );
  if (patchKeys.length === 0) {
    return c.json({ success: false, error: "No valid fields to update" }, 400);
  }

  const sets = patchKeys.map((k) => `${k} = ?`).join(", ");
  const vals = patchKeys.map((k) => coerceShopSettingValue(k, body[k]));

  try {
    const upd = await c.env.DB.prepare(`UPDATE shop_settings SET ${sets} WHERE shop_id = ?`)
      .bind(...vals, shop.id)
      .run();
    const changes = Number((upd.meta as { changes?: number }).changes ?? 0);
    if (changes === 0) {
      await c.env.DB.prepare("INSERT INTO shop_settings (shop_id) VALUES (?)").bind(shop.id).run();
      await c.env.DB.prepare(`UPDATE shop_settings SET ${sets} WHERE shop_id = ?`)
        .bind(...vals, shop.id)
        .run();
    }
    return c.json({ success: true, data: { updated: patchKeys } });
  } catch (e) {
    console.error("[shops] PATCH settings", e);
    return c.json({ success: false, error: "Failed to save settings" }, 500);
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

function genSettingsKvKey(shopId: string): string {
  return `gen:settings:${shopId}`;
}

/** Matches [vars] ASSET_BASE_URL in wrangler.toml — used if env var missing at runtime. */
const DEFAULT_ASSET_PUBLIC_BASE = "https://pivot-parlor-api.bmorris0565.workers.dev";

function assetPublicUrl(
  c: { env: Bindings; req?: { url: string } },
  shopSlug: string,
  filename: string
): string {
  let base = (c.env.ASSET_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (!base && c.req?.url) {
    try {
      base = new URL(c.req.url).origin;
    } catch {
      /* ignore */
    }
  }
  if (!base) base = DEFAULT_ASSET_PUBLIC_BASE;
  return `${base}/assets/${shopSlug}/${filename}`;
}

async function ensureDraftShopSiteRow(db: D1Database, shopId: string): Promise<void> {
  const existing = await getShopSiteByShopId(db, shopId);
  if (existing) return;
  await createShopSite(db, {
    id: crypto.randomUUID(),
    shop_id: shopId,
    template: "minimal",
    status: "active",
    website_status: "draft",
  });
}

// ─── POST /api/shops/:shopId/settings — save dev generation prefs to KV (24h) ───

shops.post("/:shopId/settings", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const body = await c.req
    .json<{ design_notes?: string; text_model?: string; image_model?: string }>()
    .catch(() => ({}));
  await c.env.KV.put(
    genSettingsKvKey(shop.id),
    JSON.stringify({
      design_notes: typeof body.design_notes === "string" ? body.design_notes : "",
      text_model: typeof body.text_model === "string" ? body.text_model : "",
      image_model: typeof body.image_model === "string" ? body.image_model : "",
    }),
    { expirationTtl: 60 * 60 * 24 }
  );
  return c.json({ ok: true });
});

// ─── POST /api/shops/:shopId/generate-image — OpenRouter → R2 (developer or admin) ───

const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";

shops.post("/:shopId/generate-image", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[generate-image] OPENROUTER_API_KEY not configured", { shopId: shop.id });
    return c.json({ error: "OPENROUTER_API_KEY not configured" }, 503);
  }

  const contentType = c.req.header("Content-Type") || "";
  let rawText: string;
  try {
    rawText = await c.req.text();
  } catch (e) {
    console.error("[generate-image] failed to read request body", { shopId: shop.id, err: String(e) });
    return c.json({ error: "Could not read request body" }, 400);
  }

  let body: Record<string, unknown> = {};
  if (rawText.trim()) {
    try {
      body = JSON.parse(rawText) as Record<string, unknown>;
    } catch (e) {
      console.error("[generate-image] invalid JSON body", {
        shopId: shop.id,
        contentType,
        bodyPreview: rawText.slice(0, 2000),
        parseError: String(e),
      });
      return c.json(
        {
          error: `Invalid JSON body: ${e instanceof Error ? e.message : String(e)}`,
        },
        400
      );
    }
  } else {
    console.error("[generate-image] empty body", { shopId: shop.id, contentType });
    return c.json(
      {
        error:
          'Empty request body: send JSON with required field "type" ("logo" or "hero"); optional "image_model" and "design_notes".',
      },
      400
    );
  }

  const typeRaw = body.type;
  const type = typeRaw === "hero" || typeRaw === "logo" ? typeRaw : null;
  if (!type) {
    console.error("[generate-image] invalid or missing type", {
      shopId: shop.id,
      receivedBody: body,
      typeField: typeRaw,
      typeFieldType: typeof typeRaw,
    });
    const got =
      typeRaw === undefined
        ? "undefined (missing)"
        : typeof typeRaw === "string"
          ? JSON.stringify(typeRaw)
          : JSON.stringify(typeRaw);
    return c.json(
      {
        error: `Invalid field "type": must be "logo" or "hero"; received ${got}`,
      },
      400
    );
  }

  const imageModelRaw = body.image_model;
  const imageModel =
    typeof imageModelRaw === "string" && imageModelRaw.trim()
      ? imageModelRaw.trim()
      : DEFAULT_OPENROUTER_IMAGE_MODEL;
  const notes =
    typeof body.design_notes === "string" ? body.design_notes.trim() : "";

  const shopTypeLabel = shop.type.replace(/_/g, " ");

  const prompt =
    type === "hero"
      ? `Cinematic interior of a ${shopTypeLabel} called ${shop.name}. ${notes}. Professional photography, dramatic lighting, no people, wide angle.`
      : `Minimalist professional logo for ${shop.name}. ${notes}. Clean lines, scalable, white background.`;

  const aspectRatio = type === "hero" ? "16:9" : "1:1";
  const filename = `${type}.png`;
  const key = `shops/${shop.slug}/${filename}`;

  try {
    const buf = await generateOpenRouterImageBuffer(
      prompt,
      aspectRatio,
      apiKey,
      `[shop-generate-image][${type}]`,
      imageModel
    );
    await c.env.ASSETS.put(key, buf, { httpMetadata: { contentType: "image/png" } });
    const imageUrl = assetPublicUrl(c, shop.slug, filename);
    return c.json({ imageUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[generate-image] image generation or upload failed", {
      shopId: shop.id,
      slug: shop.slug,
      type,
      imageModel,
      error: msg,
    });
    return c.json({ error: msg || "Image generation failed" }, 500);
  }
});

// ─── POST /api/shops/:shopId/upload-image — multipart file → R2 ───

shops.post("/:shopId/upload-image", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  let form: Record<string, unknown>;
  try {
    form = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return c.json({ success: false, error: "Invalid multipart body" }, 400);
  }
  const typeRaw = form.type;
  const type = typeRaw === "hero" || typeRaw === "logo" ? typeRaw : null;
  if (!type) return c.json({ success: false, error: "type must be logo or hero" }, 400);
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ success: false, error: "file required" }, 400);
  }

  const filename = `${type}.png`;
  const key = `shops/${shop.slug}/${filename}`;
  const buf = await file.arrayBuffer();
  const ext = file.name.match(/\.(png|jpg|jpeg|webp)$/i)?.[1] ?? "png";
  const contentType =
    file.type ||
    (ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png");

  await c.env.ASSETS.put(key, buf, { httpMetadata: { contentType } });
  const imageUrl = assetPublicUrl(c, shop.slug, filename);
  return c.json({ imageUrl });
});

// ─── POST /api/shops/:shopId/save-image — persist URL on shop_sites ───

shops.post("/:shopId/save-image", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ type?: string; imageUrl?: string }>().catch(() => ({}));
  const type = body.type === "hero" || body.type === "logo" ? body.type : null;
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  if (!type || !imageUrl) return c.json({ success: false, error: "type and imageUrl required" }, 400);

  await ensureDraftShopSiteRow(c.env.DB, shop.id);
  if (type === "hero") {
    await updateShopSiteHeroImageUrl(c.env.DB, shop.id, imageUrl);
  } else {
    await updateShopSiteLogoUrl(c.env.DB, shop.id, imageUrl);
  }

  // Bust KV cache so the public site reflects the new image immediately
  await c.env.KV.delete(`site:${shop.slug}`);

  return c.json({ ok: true });
});

// ─── POST /api/shops/:shopId/activate — developer only ───

shops.post("/:shopId/activate", authMiddleware, requireRole("developer"), async (c) => {
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  await updateShopSiteWebsiteStatus(c.env.DB, shop.id, "live");
  return c.json({ ok: true });
});

// ─── POST /api/shops/:shopId/pause — developer only ───

shops.post("/:shopId/pause", authMiddleware, requireRole("developer"), async (c) => {
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  await updateShopSiteWebsiteStatus(c.env.DB, shop.id, "paused");
  return c.json({ ok: true });
});

// ─── POST /api/shops/:shopId/generate-site — AI site generation (developer or admin) ───

shops.post("/:shopId/generate-site", authMiddleware, async (c) => {
  const user = getUser(c);
  const { shopId } = c.req.param();

  const shop = await getShopById(c.env.DB, shopId) ?? (await getShopBySlug(c.env.DB, shopId));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const contentType = c.req.header("Content-Type") ?? "";
  let body: {
    template?: string;
    color_primary?: string;
    color_accent?: string;
    design_notes?: string;
    logo_file?: File;
    text_model?: string;
    image_model?: string;
    skip_images?: boolean;
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

  const settingsRaw = await c.env.KV.get(genSettingsKvKey(shop.id));
  let settingsKv: { design_notes?: string; text_model?: string; image_model?: string } = {};
  if (settingsRaw) {
    try {
      settingsKv = JSON.parse(settingsRaw) as typeof settingsKv;
    } catch {
      /* ignore */
    }
  }

  const styleNotesMerged =
    (typeof body.design_notes === "string" && body.design_notes.trim()
      ? body.design_notes.trim()
      : settingsKv.design_notes?.trim()) ?? "";

  const skip_images = body.skip_images === true;

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

    const researchServices = await buildSiteResearchQueueServices(c.env.DB, shop.id);

    const logoUploadHead = await c.env.ASSETS.head(`shops/${shop.slug}/logo-upload`);
    const hasLogoFile =
      Boolean(body.logo_file && body.logo_file.size > 0) || logoUploadHead !== null;

    const text_model =
      typeof body.text_model === "string" && body.text_model.trim()
        ? body.text_model.trim()
        : settingsKv.text_model?.trim() || "google/gemini-3.1-flash-lite-preview";
    const image_model =
      typeof body.image_model === "string" && body.image_model.trim()
        ? body.image_model.trim()
        : settingsKv.image_model?.trim() || "google/gemini-3.1-flash-image-preview";

    const queuePayload = {
      jobId,
      shopId: shop.id,
      shopName: shop.name,
      shopSlug: shop.slug,
      shopType: shop.type as "barber_shop" | "beauty_parlor" | "both",
      styleNotes: styleNotesMerged,
      hasLogoFile,
      services: researchServices,
      text_model,
      image_model,
      skip_images,
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
    await updateShopSiteWebsiteStatus(c.env.DB, shop.id, "draft");
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
