import { Hono, type Context } from "hono";
import Stripe from "stripe";
import type { D1Database } from "@cloudflare/workers-types";
import type { Bindings } from "../bindings.js";
import {
  getAllShops,
  getShopById,
  getShopBySlug,
  ensureE2eBookableShop,
  E2E_BOOKABLE_SLUG,
  createShop,
  getNextShopNumber,
  createInvite,
  getShopSiteByShopId,
  getShopSiteFacts,
  updateShopStripeSession,
  insertGenerationJob,
  updateGenerationJob,
  getStaffByShop,
  getServicesByShop,
  getServiceById,
  getShopSiteImages,
  updateShopSiteWebsiteStatus,
  shopSiteWebsiteStatusStatement,
  getSiteCandidate,
  deleteSiteCandidate,
  publishSiteCandidateStatements,
  type DBService,
} from "../db/queries.js";
import {
  parseVisualType,
  persistVisualImage,
  clearVisualImage,
  customVisualFilename,
} from "../services/visual-images.js";
import {
  safeJsonParse,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  parseComposer,
  buildServiceImagePrompt,
} from "@repo/utils";
import { AuditWriteError, userSubjectId } from "@repo/audit";
import { auditFor, auditRefused, batchWithAudit } from "../audit/context.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { buildSiteResearchBusiness } from "../lib/siteResearchContext.js";
import { buildSiteData, siteDesignIntent, siteWebsiteStatus } from "../lib/siteData.js";
import {
  overlayCandidate,
  parseCandidatePayload,
  servicesUnchanged,
  withoutLockedImages,
  type CandidateColumn,
} from "../lib/siteCandidate.js";
import { toPublicService } from "./services.js";
import { serviceDescriptionsByName } from "../lib/serviceCopy.js";
import { requireRole, requireShopRole } from "../middleware/rbac.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { e2eMockAllowed } from "../lib/e2e.js";
import { generateOpenRouterImageBuffer } from "../services/openrouter-image-generation.js";
import { getLiveModels, parseTextEffort, providerKeysFromEnv } from "../services/model-registry.js";

/** `listed(id, kind)` against the live registry (KV-cached); one read per request. */
async function modelLister(c: Context<{ Bindings: Bindings }>): Promise<(id: string, kind: "text" | "image") => boolean> {
  const registry = await getLiveModels(c.env.KV, providerKeysFromEnv(c.env));
  return (id, kind) => registry.some((m) => m.id === id && m.kind === kind);
}

const shops = new Hono<{ Bindings: Bindings }>();

/** Upload cap for shop images (logo/hero) — matches the staff-avatar limit. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Matches `ResearchQueueMessage.services` in apps/workers/research. */
type SiteResearchQueueService = { name: string; price_gbp: number; duration_min: number; category?: string };

function mapDbServiceToResearchQueue(row: DBService): SiteResearchQueueService {
  // price_gbp is a presentation value for the AI site pipeline, not money math.
  const category = row.category?.trim();
  return {
    name: row.name,
    price_gbp: row.price_pence / 100,
    duration_min: row.duration_min,
    ...(category ? { category } : {}),
  };
}

async function buildSiteResearchQueueServices(
  db: D1Database,
  shopId: string
): Promise<SiteResearchQueueService[]> {
  // The services table is the only source: it is what the booking flow sells,
  // so the generated menu can never disagree with it. This used to top a
  // short menu up from the previous generation's services_json (itself model
  // output, once told to "invent exactly 3 plausible services") and then pad
  // to two with "Default service N" at £25; both could publish services the
  // shop does not offer. A shop with no services generates a site without a
  // menu (the pipeline accepts zero) until the owner adds real ones.
  const dbRows = await getServicesByShop(db, shopId);
  return dbRows.map(mapDbServiceToResearchQueue);
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
    commission_total_pence: 0,
  },
];

shops.get("/", authMiddleware, requireRole("developer"), async (c) => {
  // Playwright sets cookie → Remix forwards header; SSR bypasses page.route().
  if (e2eMockAllowed(c.env, c.req.header("X-E2E-Test-Mock-Stripe-List"))) {
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

  // Try KV cache first (a corrupt value degrades to a miss, not a crash)
  const cached = safeJsonParse(await c.env.KV.get(`shop:theme:${shop.id}`));
  if (cached) {
    return c.json({ success: true, data: cached });
  }

  // Fall back to D1
  const theme = safeJsonParse(shop.ai_theme);
  if (theme) {
    // Back-fill KV cache with the raw stored JSON
    await c.env.KV.put(`shop:theme:${shop.id}`, shop.ai_theme!, {
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

  const freshServices = safeJsonParse<unknown[]>(site.services_json) ?? [];
  const websiteStatus = siteWebsiteStatus(site);
  // Design intent persisted by the assembler (WS-6 onward); shared with the
  // owner-review preview so both read the same shape.
  const designIntent = siteDesignIntent(site);

  const cached = await c.env.KV.get(`site:${shop.slug}`);
  if (cached) {
    try {
      const data = JSON.parse(cached) as Record<string, unknown>;
      data.services = freshServices;
      data.website_status = websiteStatus;
      // Always refresh image URLs from D1 — KV snapshot can be stale after save-image / pipeline
      data.hero_image_url = site.hero_image_url;
      data.logo_url = site.logo_url;
      // Same for the design intent — pre-WS-6 cache snapshots don't carry it.
      Object.assign(data, designIntent);
      return c.json({ success: true, data });
    } catch {
      /* fall through to rebuild from D1 */
    }
  }

  const data = buildSiteData(site);

  await c.env.KV.put(`site:${shop.slug}`, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 });
  return c.json({ success: true, data });
});

// ─── Owner review for regenerated public sites (migration 049) ──────────────
// A regeneration of a live or paused site is stored as a candidate instead of
// replacing the public site. Developers, or the shop's own admin, can preview
// it, publish it or discard it. requireShopRole compares :shopId with the
// admin's shop_id, so an admin must address their own shop by id; an admin of
// another shop, staff and customers get 403, and no token gets 401.

async function shopForReview(c: Context<{ Bindings: Bindings }>) {
  const param = c.req.param("shopId") ?? "";
  return (await getShopById(c.env.DB, param)) ?? (await getShopBySlug(c.env.DB, param));
}

const SERVICES_CHANGED =
  "The shop's services changed after this version was made, so its service photos would land on the wrong services. Regenerate the site to get a matching version.";

shops.get("/:shopId/site-candidate", authMiddleware, requireShopRole("admin"), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const shop = await shopForReview(c);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  const candidate = await getSiteCandidate(c.env.DB, shop.id);
  if (!candidate) return c.json({ success: false, error: "No new version is waiting for review" }, 404);
  const payload = parseCandidatePayload(candidate.payload_json);
  const site = await getShopSiteByShopId(c.env.DB, shop.id);
  if (!payload || !site) {
    return c.json({ success: false, error: "This version can no longer be shown. Regenerate the site." }, 409);
  }
  const rows = await getServicesByShop(c.env.DB, shop.id);
  // Preview exactly what Publish will write: the same lock rule, the same
  // public shapes, the candidate's own service descriptions.
  const columns = withoutLockedImages(payload.columns, (site as { locked_images_json?: string | null }).locked_images_json);
  const merged = overlayCandidate(site as unknown as Record<string, unknown>, columns) as unknown as typeof site;
  const descriptions = serviceDescriptionsByName(merged.services_json);
  return c.json({
    success: true,
    data: {
      job_id: candidate.job_id,
      created_at: candidate.created_at,
      services_unchanged: servicesUnchanged(payload.service_names, rows.map((r) => r.name)),
      site: buildSiteData(merged),
      services: rows.map((r) => toPublicService(r, descriptions)),
    },
  });
});

/** Version ids are server-made generation job ids. Bound what a request can
 *  put into an audit entry, which is hashed and kept for 6 years (Ruling 14),
 *  before anything is recorded. */
const CANDIDATE_JOB_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Audit outcome for a site-candidate response: 4xx is a refusal and 5xx a
 *  failure, the same split the gap guard uses. */
const candidateOutcome = (jobId: string) => (res: Response) => ({
  outcome: res.status >= 500 ? ("failed" as const) : res.status >= 400 ? ("refused" as const) : ("succeeded" as const),
  reason: res.status < 400 ? null : `HTTP ${res.status}`,
  details: { job_id: jobId },
});

shops.post("/:shopId/site-candidate/publish", authMiddleware, requireShopRole("admin"), async (c) => {
  const shop = await shopForReview(c);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { job_id?: unknown };
  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!jobId) return c.json({ success: false, error: "job_id is required: publish the version you previewed" }, 400);
  if (!CANDIDATE_JOB_ID.test(jobId)) return c.json({ success: false, error: "job_id is not a valid version id" }, 400);

  try {
    return await auditFor(c).run(
      {
        action: "site.candidate.publish",
        shopId: shop.id,
        entityType: "shop_site",
        entityId: shop.id,
        details: { job_id: jobId },
      },
      async (): Promise<Response> => {
        const candidate = await getSiteCandidate(c.env.DB, shop.id);
        if (!candidate) return c.json({ success: false, error: "No new version is waiting for review" }, 404);
        if (candidate.job_id !== jobId) {
          return c.json({ success: false, error: "A newer version replaced the one you previewed. Preview it before publishing." }, 409);
        }
        const payload = parseCandidatePayload(candidate.payload_json);
        if (!payload) {
          return c.json({ success: false, error: "This version cannot be published by this release. Regenerate the site." }, 409);
        }
        const site = await getShopSiteByShopId(c.env.DB, shop.id);
        if (!site) return c.json({ success: false, error: "The shop has no published site to update." }, 409);
        const rows = await getServicesByShop(c.env.DB, shop.id);
        if (!servicesUnchanged(payload.service_names, rows.map((r) => r.name))) {
          return c.json({ success: false, error: SERVICES_CHANGED }, 409);
        }

        const columns = withoutLockedImages(payload.columns, (site as { locked_images_json?: string | null }).locked_images_json);
        const entries = Object.entries(columns) as Array<[CandidateColumn, string | number | null]>;
        const results = await c.env.DB.batch(
          publishSiteCandidateStatements(c.env.DB, {
            shopId: shop.id,
            jobId,
            columns: entries,
            ownerPalette: payload.owner_palette,
          }),
        );
        // The last statement removes the candidate. If it removed nothing, a newer
        // regeneration replaced this one mid-publish and every write was skipped.
        const removed = results[results.length - 1]?.meta?.changes ?? 0;
        if (removed === 0) {
          return c.json({ success: false, error: "A newer version replaced the one you previewed. Preview it before publishing." }, 409);
        }
        try {
          await c.env.KV.delete(`site:${shop.slug}`);
        } catch (err) {
          // /site re-reads services, status, images and design intent from D1 on
          // every request; only headline, tagline, about, colours, fonts and SEO
          // would stay on the cached copy until its 24h expiry.
          console.error(`[site-candidate] KV bust failed shop=${shop.id}`, err);
        }
        console.log(`[site-candidate] published job=${jobId} shop=${shop.id} columns=${entries.length}`);
        return c.json({ success: true, data: { published: true, job_id: jobId } });
      },
      candidateOutcome(jobId),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

shops.delete("/:shopId/site-candidate", authMiddleware, requireShopRole("admin"), async (c) => {
  const shop = await shopForReview(c);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  const jobId = (c.req.query("job_id") ?? "").trim();
  if (!jobId) return c.json({ success: false, error: "job_id is required: discard the version you previewed" }, 400);
  if (!CANDIDATE_JOB_ID.test(jobId)) return c.json({ success: false, error: "job_id is not a valid version id" }, 400);

  try {
    return await auditFor(c).run(
      {
        action: "site.candidate.discard",
        shopId: shop.id,
        entityType: "shop_site",
        entityId: shop.id,
        details: { job_id: jobId },
      },
      async (): Promise<Response> => {
        const candidate = await getSiteCandidate(c.env.DB, shop.id);
        if (!candidate) return c.json({ success: false, error: "No new version is waiting for review" }, 404);
        if (candidate.job_id !== jobId) {
          return c.json({ success: false, error: "A newer version replaced the one you previewed." }, 409);
        }
        await deleteSiteCandidate(c.env.DB, shop.id, jobId);
        console.log(`[site-candidate] discarded job=${jobId} shop=${shop.id}`);
        return c.json({ success: true, data: { discarded: true, job_id: jobId } });
      },
      candidateOutcome(jobId),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
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
  // Public profile only: the admin-uploaded portrait (staff/:id/avatar) and the
  // owner-entered specialism are meant for the shop's site. Email, user id and
  // schedule stay private.
  const data = members.map((m) => ({
    id: m.id,
    display_name: m.display_name,
    bio: m.bio ?? undefined,
    avatar_url: m.avatar_url ?? undefined,
    speciality: m.speciality ?? undefined,
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
//
// booking_id is REQUIRED (WS-7): reviews without one accepted unlimited
// fake/defamatory entries. The review-request email links customers here with
// their booking id (?review=<id>), which is the intended entry point.

shops.post(
  "/:shopId/reviews",
  rateLimit({ name: "reviews", limit: 5, windowS: 3600, key: clientIp }),
  async (c) => {
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
    if (name.length > 120) return c.json({ success: false, error: "Name is too long" }, 400);
    if (!text) return c.json({ success: false, error: "Review text is required" }, 400);
    if (text.length > 2000) return c.json({ success: false, error: "Review text is too long (max 2000 characters)" }, 400);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return c.json({ success: false, error: "Rating must be 1–5" }, 400);
    }
    if (!bookingId || bookingId.length > 100) {
      return c.json({ success: false, error: "A booking is required to leave a review" }, 400);
    }

    // The booking must belong to this shop, still stand, and have started —
    // you review a visit, not a reservation.
    const booking = await c.env.DB
      .prepare("SELECT id, status, booking_date FROM bookings WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(bookingId, shop.id)
      .first<{ id: string; status: string; booking_date: string }>();
    if (!booking || booking.status === "cancelled" || booking.status === "no_show") {
      return c.json({ success: false, error: "Invalid booking" }, 400);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (booking.booking_date > today) {
      return c.json({ success: false, error: "You can leave a review after your visit" }, 400);
    }

    // One review per booking
    const existing = await c.env.DB
      .prepare("SELECT id FROM reviews WHERE booking_id = ? LIMIT 1")
      .bind(bookingId)
      .first<{ id: string }>();
    if (existing) return c.json({ success: false, error: "Review already submitted for this booking" }, 409);

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
      google_business_url: row.google_business_url ?? "",
      show_google_business: flag(row.show_google_business),
      booking_enabled: flag(row.booking_enabled) === false ? false : true,
      booking_confirmation_email: flag(row.booking_confirmation_email) !== false,
      booking_reminder_email: flag(row.booking_reminder_email) !== false,
      reminder_hours_before: typeof row.reminder_hours_before === "number" ? row.reminder_hours_before : 24,
      review_request_email: flag(row.review_request_email) !== false,
      // Customer deposits (migration 041) — public so the booking UI can show
      // the deposit due before the customer commits.
      deposits_enabled: flag(row.deposits_enabled) === true,
      deposit_percent: typeof row.deposit_percent === "number" ? row.deposit_percent : 50,
      deposit_min_pence: typeof row.deposit_min_pence === "number" ? row.deposit_min_pence : 500,
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
  "google_business_url",
  "show_google_business",
  "booking_confirmation_email",
  "booking_reminder_email",
  "reminder_hours_before",
  "review_request_email",
  "deposits_enabled",
  "deposit_percent",
  "deposit_min_pence",
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
  if (field === "deposits_enabled") {
    return raw === true || raw === 1 || raw === "1" ? 1 : 0;
  }
  if (field === "deposit_percent") {
    const n = typeof raw === "number" ? raw : Number(String(raw));
    return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 50;
  }
  if (field === "deposit_min_pence") {
    const n = typeof raw === "number" ? raw : Number(String(raw));
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 500;
  }
  if (field === "google_business_url") {
    return typeof raw === "string" ? raw.trim() : "";
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

  type GenSettingsBody = {
    design_notes?: string;
    text_model?: string;
    text_effort?: string;
    image_model?: string;
    composer?: string;
  };
  const body = await c.req.json<GenSettingsBody>().catch((): GenSettingsBody => ({}));

  const textModelIn = typeof body.text_model === "string" ? body.text_model.trim() : "";
  const imageModelIn = typeof body.image_model === "string" ? body.image_model.trim() : "";
  const listed = textModelIn || imageModelIn ? await modelLister(c) : null;
  if (textModelIn && !listed?.(textModelIn, "text")) {
    return c.json({ success: false, error: `Unknown text model: ${textModelIn}` }, 400);
  }
  if (imageModelIn && !listed?.(imageModelIn, "image")) {
    return c.json({ success: false, error: `Unknown image model: ${imageModelIn}` }, 400);
  }
  const composerIn = typeof body.composer === "string" ? body.composer.trim() : "";
  if (composerIn && !parseComposer(composerIn)) {
    return c.json({ success: false, error: `Unknown composer: ${composerIn}` }, 400);
  }

  await c.env.KV.put(
    genSettingsKvKey(shop.id),
    JSON.stringify({
      design_notes: typeof body.design_notes === "string" ? body.design_notes : "",
      text_model: textModelIn,
      text_effort: parseTextEffort(body.text_effort) ?? "",
      image_model: imageModelIn,
      composer: composerIn || undefined,
    }),
    { expirationTtl: 60 * 60 * 24 }
  );
  return c.json({ ok: true });
});

// ─── POST /api/shops/:shopId/generate-image — OpenRouter → R2 (developer-only) ───

const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-3.1-flash-image";

shops.post("/:shopId/generate-image", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ error: "Shop not found" }, 404);
  if (user.role !== "developer") {
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
          'Empty request body: send JSON with required field "type" ("logo", "hero" or "service:<id>"); optional "image_model" and "design_notes".',
      },
      400
    );
  }

  const target = parseVisualType(body.type);
  if (!target) {
    console.error("[generate-image] invalid or missing type", { shopId: shop.id, typeField: body.type });
    return c.json({ error: `Invalid field "type": must be "logo", "hero" or "service:<id>"` }, 400);
  }
  let serviceRow: Awaited<ReturnType<typeof getServiceById>> = null;
  if (target.kind === "service") {
    serviceRow = await getServiceById(c.env.DB, target.serviceId);
    if (!serviceRow || serviceRow.shop_id !== shop.id) {
      return c.json({ error: "Service not found" }, 404);
    }
  }

  const imageModelRaw = body.image_model;
  const imageModelIn = typeof imageModelRaw === "string" ? imageModelRaw.trim() : "";
  if (imageModelIn && !(await modelLister(c))(imageModelIn, "image")) {
    return c.json({ success: false, error: `Unknown image model: ${imageModelIn}` }, 400);
  }
  const imageModel = imageModelIn || DEFAULT_OPENROUTER_IMAGE_MODEL;
  const notes =
    typeof body.design_notes === "string" ? body.design_notes.trim() : "";

  const shopTypeLabel = shop.type.replace(/_/g, " ");
  const typeLabel = target.kind === "service" ? `service:${target.serviceId}` : target.kind;

  const prompt =
    target.kind === "service"
      ? buildServiceImagePrompt(serviceRow!.name, shop.type)
      : target.kind === "hero"
        ? `Cinematic interior of a ${shopTypeLabel} called ${shop.name}. ${notes}. Professional photography, dramatic lighting, no people, wide angle.`
        : `Minimalist professional logo for ${shop.name}. ${notes}. Clean lines, scalable, white background.`;

  const aspectRatio = target.kind === "hero" ? "16:9" : "1:1";
  const filename = customVisualFilename(target);
  const key = `shops/${shop.slug}/${filename}`;

  try {
    const buf = await generateOpenRouterImageBuffer(
      prompt,
      aspectRatio,
      apiKey,
      `[shop-generate-image][${typeLabel}]`,
      imageModel
    );
    await c.env.ASSETS.put(key, buf, { httpMetadata: { contentType: "image/png" } });
    const imageUrl = assetPublicUrl(c, shop.slug, filename);

    await persistVisualImage(c.env.DB, c.env.KV, {
      shopId: shop.id,
      slug: shop.slug,
      target,
      imageUrl,
    });

    return c.json({ imageUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[generate-image] image generation or upload failed", {
      shopId: shop.id,
      slug: shop.slug,
      type: typeLabel,
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
  const target = parseVisualType(form.type);
  if (!target) {
    return c.json({ success: false, error: "type must be logo, hero or service:<id>" }, 400);
  }
  if (target.kind === "service") {
    const svc = await getServiceById(c.env.DB, target.serviceId);
    if (!svc || svc.shop_id !== shop.id) {
      return c.json({ success: false, error: "Service not found" }, 404);
    }
  }
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ success: false, error: "file required" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ success: false, error: "File too large (max 5MB)" }, 400);
  }

  const filename = customVisualFilename(target);
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

  const body = await c.req
    .json<{ type?: string; imageUrl?: string }>()
    .catch((): { type?: string; imageUrl?: string } => ({}));
  const target = parseVisualType(body.type);
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  if (!target || !imageUrl) {
    return c.json({ success: false, error: "type and imageUrl required" }, 400);
  }

  if (target.kind === "service") {
    const svc = await getServiceById(c.env.DB, target.serviceId);
    if (!svc || svc.shop_id !== shop.id) {
      return c.json({ success: false, error: "Service not found" }, 404);
    }
  }

  // persistVisualImage sets the URL, locks hero/logo, and busts the site cache.
  await persistVisualImage(c.env.DB, c.env.KV, {
    shopId: shop.id,
    slug: shop.slug,
    target,
    imageUrl,
  });

  return c.json({ ok: true });
});

// ─── POST /api/shops/:shopId/remove-image — clear a visual (developer-only) ───

shops.post("/:shopId/remove-image", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer") {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ type?: string }>().catch((): { type?: string } => ({}));
  const target = parseVisualType(body.type);
  if (!target) {
    return c.json({ success: false, error: "type must be logo, hero or service:<id>" }, 400);
  }

  if (target.kind === "service") {
    const svc = await getServiceById(c.env.DB, target.serviceId);
    if (!svc || svc.shop_id !== shop.id) {
      return c.json({ success: false, error: "Service not found" }, 404);
    }
  }

  await clearVisualImage(c.env.DB, c.env.KV, {
    shopId: shop.id,
    slug: shop.slug,
    target,
  });
  return c.json({ ok: true });
});

// ─── GET /api/shops/:shopId/visuals — Visual Editor read model ────────────────

shops.get("/:shopId/visuals", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const site = await getShopSiteImages(c.env.DB, shop.id);
  let locked: Record<string, unknown> = {};
  try {
    const parsed = site?.locked_images_json ? (JSON.parse(site.locked_images_json) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      locked = parsed as Record<string, unknown>;
    }
  } catch {
    locked = {};
  }
  let catalog: string[] = [];
  try {
    const parsed = site?.catalog_images_json ? (JSON.parse(site.catalog_images_json) as unknown) : [];
    if (Array.isArray(parsed)) catalog = parsed.map((x) => (typeof x === "string" ? x : ""));
  } catch {
    catalog = [];
  }
  const services = (await getServicesByShop(c.env.DB, shop.id)).map((s) => ({
    id: s.id,
    name: s.name,
    image_url: s.image_url ?? null,
  }));

  return c.json({
    success: true,
    data: {
      hero: { url: site?.hero_image_url ?? null, locked: locked.hero === true },
      logo: { url: site?.logo_url ?? null, locked: locked.logo === true },
      catalog,
      services,
    },
  });
});

// ─── GET /api/shops/:shopId/owner-details — developer: shop onboarding + linked users ───

shops.get("/:shopId/owner-details", authMiddleware, requireRole("developer"), async (c) => {
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const { results } = await c.env.DB
    .prepare(
      `SELECT id, name, email, phone, role, shop_id, created_at
       FROM platform_users
       WHERE shop_id = ?
       ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, created_at ASC`
    )
    .bind(shop.id)
    .all<{
      id: string;
      name: string | null;
      email: string;
      phone: string | null;
      role: string;
      shop_id: string | null;
      created_at: string;
    }>();

  return c.json({
    success: true,
    data: {
      owner_name: shop.owner_name,
      owner_email: shop.owner_email,
      phone: shop.phone,
      platform_users: results ?? [],
    },
  });
});

// ─── DELETE|POST /api/shops/:shopId — developer only (cascade-related cleanup) ───
// POST …/delete matches the Remix BFF pattern (same as /activate) so deletes work even when
// DELETE is not routed or an older Worker build is missing the DELETE handler.

async function deleteShopDeveloper(c: Context<{ Bindings: Bindings }>) {
  const param = c.req.param("shopId");
  if (!param) return c.json({ success: false, error: "Missing shop id" }, 400);
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  // Ruling 17: shop name and slug are personal data (sole traders trade under
  // their own name) and must never enter the permanent, unblankable
  // details_json. They live only in this redactable audit_subjects row,
  // referenced from the entry by id.
  const shopSubjectRef = `subj_shop_${shop.id}`;
  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_subjects (id, kind, shop_id, display_name, created_at)
       VALUES (?, 'shop', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, shop_id = excluded.shop_id
       WHERE audit_subjects.redacted_at IS NULL`
    )
      .bind(shopSubjectRef, shop.id, `${shop.name} (${shop.slug})`, new Date().toISOString())
      .run();
  } catch (e) {
    console.error("[shops.delete] subject upsert failed", e);
    return auditRefused(c);
  }

  const [userCountRow, bookingCountRow] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE shop_id = ?").bind(shop.id).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE shop_id = ?").bind(shop.id).first<{ n: number }>(),
  ]);

  try {
    await auditFor(c).run(
      {
        action: "shop.delete",
        shopId: shop.id,
        entityType: "shop",
        entityId: shop.id,
        details: {
          shop_subject: shopSubjectRef,
          type: shop.type,
          created_at: shop.created_at,
          users: userCountRow?.n ?? 0,
          bookings: bookingCountRow?.n ?? 0,
        },
      },
      async () => {
        await c.env.DB.prepare("DELETE FROM generation_jobs WHERE shop_id = ?").bind(shop.id).run();
        await c.env.DB
          .prepare("DELETE FROM shop_settings WHERE shop_id = ?")
          .bind(shop.id)
          .run()
          .catch(() => {
            /* table may not exist in older DB snapshots */
          });
        await c.env.DB
          .prepare("UPDATE contacts SET shop_id = NULL WHERE shop_id = ?")
          .bind(shop.id)
          .run()
          .catch(() => {
            /* best effort */
          });

        await c.env.KV.delete(`site:${shop.slug}`);
        await c.env.KV.delete(`shop:theme:${shop.id}`);
        await c.env.KV.delete(`gen:settings:${shop.id}`);
        await c.env.KV.delete(`walkin:queue:${shop.id}`);

        // Ruling 15: the redact schedule and the shop's removal commit
        // together in one batch — a failed delete must never schedule
        // blanking a live shop's people. Ruling 16: the date may only move
        // forward, never back.
        // Spec 6.2: personal details of this shop's people are blanked 30 days after it leaves.
        const redactAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        await c.env.DB.batch([
          c.env.DB
            .prepare(
              "UPDATE audit_subjects SET redact_after = ? WHERE shop_id = ? AND redacted_at IS NULL AND (redact_after IS NULL OR redact_after > ?)"
            )
            .bind(redactAfter, shop.id, redactAfter),
          c.env.DB.prepare("DELETE FROM shops WHERE id = ?").bind(shop.id),
        ]);
      }
    );
    return c.json({ success: true, data: { id: shop.id } });
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    console.error("[shops.delete]", e);
    const msg = e instanceof Error ? e.message : "Delete failed";
    return c.json({ success: false, error: msg }, 500);
  }
}

shops.delete("/:shopId", authMiddleware, requireRole("developer"), deleteShopDeveloper);
shops.post("/:shopId/delete", authMiddleware, requireRole("developer"), deleteShopDeveloper);

async function changeWebsiteStatus(
  c: Context<{ Bindings: Bindings }>,
  status: "live" | "paused",
  action: "site.activate" | "site.pause"
) {
  const param = c.req.param("shopId");
  if (!param) return c.json({ success: false, error: "Missing shop id" }, 400);
  const shop = (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  const site = await c.env.DB.prepare(
    "SELECT website_status FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1"
  )
    .bind(shop.id)
    .first<{ website_status: string | null }>();
  const refused = await batchWithAudit(c, [shopSiteWebsiteStatusStatement(c.env.DB, shop.id, status)], {
    action,
    outcome: "succeeded",
    shopId: shop.id,
    entityType: "shop_site",
    entityId: shop.id,
    changes: site ? { website_status: [site.website_status ?? null, status] } : null,
    details: site ? null : { no_site_row: true },
  });
  if (refused) return refused;
  return c.json({ ok: true });
}

// ─── POST /api/shops/:shopId/activate — developer only ───
shops.post("/:shopId/activate", authMiddleware, requireRole("developer"), (c) =>
  changeWebsiteStatus(c, "live", "site.activate")
);

// ─── POST /api/shops/:shopId/pause — developer only ───
shops.post("/:shopId/pause", authMiddleware, requireRole("developer"), (c) =>
  changeWebsiteStatus(c, "paused", "site.pause")
);

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
    text_effort?: string;
    image_model?: string;
    skip_images?: boolean;
    composer?: string;
  } = {};

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    body = {
      template: form.template?.toString(),
      color_primary: form.color_primary?.toString(),
      color_accent: form.color_accent?.toString(),
      design_notes: form.design_notes?.toString(),
      logo_file: form.logo_file instanceof File ? form.logo_file : undefined,
      composer: form.composer?.toString(),
    };
  } else {
    const json = await c.req.json<typeof body>().catch((): typeof body => ({}));
    body = json;
  }

  // Cap before any buffering — same limit as the other image uploads.
  if (body.logo_file && body.logo_file.size > MAX_UPLOAD_BYTES) {
    return c.json({ success: false, error: "Logo file too large (max 5MB)" }, 400);
  }

  // Validate explicit model ids before any job/KV state is created below —
  // an unknown or wrong-kind id must 400 without orphaning a queued job row.
  const listed = await modelLister(c);
  const bodyText = typeof body.text_model === "string" ? body.text_model.trim() : "";
  if (bodyText && !listed(bodyText, "text")) {
    return c.json({ success: false, error: `Unknown text model: ${bodyText}` }, 400);
  }
  const bodyImage = typeof body.image_model === "string" ? body.image_model.trim() : "";
  if (bodyImage && !listed(bodyImage, "image")) {
    return c.json({ success: false, error: `Unknown image model: ${bodyImage}` }, 400);
  }
  const bodyComposerRaw = typeof body.composer === "string" ? body.composer.trim() : "";
  if (bodyComposerRaw && !parseComposer(bodyComposerRaw)) {
    return c.json({ success: false, error: `Unknown composer: ${bodyComposerRaw}` }, 400);
  }

  const settingsRaw = await c.env.KV.get(genSettingsKvKey(shop.id));
  let settingsKv: {
    design_notes?: string;
    text_model?: string;
    text_effort?: string;
    image_model?: string;
    composer?: string;
  } = {};
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

  // Owner-chosen template (WS-6): forwarded to the research worker, which
  // pins layout_mood to it. Anything outside the known set — including the
  // "auto" / "Let AI decide" value — leaves the choice to the model.
  // Ruling 14: validated BEFORE the audit entry is built, since details_json
  // is hashed and locked for 6 years — never the raw, unbounded request string.
  const KNOWN_TEMPLATES = ["minimal", "luxury", "vibrant", "editorial", "classic", "fresh"];
  const ownerTemplate =
    typeof body.template === "string" && KNOWN_TEMPLATES.includes(body.template.trim().toLowerCase())
      ? body.template.trim().toLowerCase()
      : undefined;

  let jobId: string | null = null;
  const nowKv = () =>
    JSON.stringify({
      status: "queued",
      stage: "research",
      shopSlug: shop.slug,
    });

  try {
    return await auditFor(c).run(
      {
        action: "site.regenerate.request",
        shopId: shop.id,
        entityType: "shop_site",
        entityId: shop.id,
        details: {
          text_model: bodyText || null,
          image_model: bodyImage || null,
          skip_images: body.skip_images === true,
          composer: bodyComposerRaw || null,
          template: ownerTemplate ?? null,
        },
      },
      async (): Promise<Response> => {
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
          // Owner-entered facts (team, hours, area): the only business facts the
          // generated copy may state. Older research workers ignore the field.
          const [teamRows, siteFacts] = await Promise.all([
            getStaffByShop(c.env.DB, shop.id),
            getShopSiteFacts(c.env.DB, shop.id),
          ]);
          const business = buildSiteResearchBusiness({
            staff: teamRows,
            services: researchServices,
            address: siteFacts?.address,
            hours_json: siteFacts?.hours_json,
          });

          const logoUploadHead = await c.env.ASSETS.head(`shops/${shop.slug}/logo-upload`);
          const hasLogoFile =
            Boolean(body.logo_file && body.logo_file.size > 0) || logoUploadHead !== null;

          // bodyText/bodyImage are already validated (400'd above if unknown). A
          // stored KV value that no longer resolves in the catalog (a catalog
          // shrink) silently degrades to the pipeline default instead of 400ing,
          // so legacy shops keep generating.
          const storedText = settingsKv.text_model?.trim() ?? "";
          const storedTextListed = Boolean(storedText) && listed(storedText, "text");
          if (!bodyText && storedText && !storedTextListed) {
            console.warn(`[generate-site] stored text model ${storedText} is no longer listed; using ${DEFAULT_TEXT_MODEL_ID}`);
          }
          const text_model = bodyText || (storedTextListed ? storedText : DEFAULT_TEXT_MODEL_ID);
          // Reasoning effort for the text/research model. Request wins over saved
          // settings; anything but low/medium/high is dropped (pipeline default).
          const text_effort =
            parseTextEffort(body.text_effort) ?? parseTextEffort(settingsKv.text_effort);
          const storedImage = settingsKv.image_model?.trim() ?? "";
          const storedImageListed = Boolean(storedImage) && listed(storedImage, "image");
          if (!bodyImage && storedImage && !storedImageListed) {
            console.warn(`[generate-site] stored image model ${storedImage} is no longer listed; using ${DEFAULT_IMAGE_MODEL_ID}`);
          }
          const image_model = bodyImage || (storedImageListed ? storedImage : DEFAULT_IMAGE_MODEL_ID);
          // Design Director composer: request wins over saved settings; anything
          // but ai/seed (incl. legacy junk in KV) silently defaults to "ai".
          const composer =
            parseComposer(bodyComposerRaw) ?? parseComposer(settingsKv.composer) ?? "ai";

          // Optional owner-chosen palette. Only honour a complete, valid pair so a
          // partial/garbage value can never override the AI-generated palette.
          const isHex6 = (v: unknown): v is string =>
            typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim());
          const ownerColorPrimary = isHex6(body.color_primary) ? body.color_primary.trim() : undefined;
          const ownerColorAccent = isHex6(body.color_accent) ? body.color_accent.trim() : undefined;
          const hasColorOverride = Boolean(ownerColorPrimary && ownerColorAccent);

          const queuePayload = {
            jobId,
            shopId: shop.id,
            shopName: shop.name,
            shopSlug: shop.slug,
            shopType: shop.type as "barber_shop" | "beauty_parlor" | "both",
            styleNotes: styleNotesMerged,
            hasLogoFile,
            services: researchServices,
            business,
            text_model,
            ...(text_effort ? { text_effort } : {}),
            image_model,
            composer,
            origin_actor_ref: user.sub ? userSubjectId(user.sub) : null,
            skip_images,
            ...(hasColorOverride
              ? { color_primary: ownerColorPrimary, color_accent: ownerColorAccent }
              : {}),
            ...(ownerTemplate ? { template: ownerTemplate } : {}),
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
          // Publication state is NOT touched here. This used to flip the site to
          // "draft", which 404'd a live site for the whole job and kept it offline
          // afterwards (success or failure) until a developer re-activated it. A
          // never-published site is already draft; a live site stays live and the
          // assembler only replaces it with output that passes its publication gate.
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
      },
      (res) => ({
        outcome: res.status < 400 ? "succeeded" : "failed",
        reason: res.status < 400 ? null : `HTTP ${res.status}`,
        details: { job_id: jobId },
      })
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

// ─── GET /api/shops/:shopId — single shop (public) ───────────────────────────

shops.get("/:shopId", async (c) => {
  const { shopId } = c.req.param();
  // E2E: lazily provision the bookable fixture shop the booking spec uses.
  if (c.env.E2E_FIXTURES === "true" && shopId === E2E_BOOKABLE_SLUG) {
    await ensureE2eBookableShop(c.env.DB);
  }
  // Try by slug first (for customer-facing URLs), fall back to ID
  const shop = await getShopBySlug(c.env.DB, shopId) ?? await getShopById(c.env.DB, shopId);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const aiTheme = safeJsonParse(shop.ai_theme);
  const safe = {
    id: shop.id,
    shop_number: shop.shop_number,
    slug: shop.slug,
    name: shop.name,
    type: shop.type,
    phone: shop.phone,
    commission_rate: shop.commission_rate,
    retail_commission_rate: shop.retail_commission_rate,
    currency: shop.currency,
    is_active: shop.is_active,
    created_at: shop.created_at,
    ...(aiTheme ? { ai_theme: aiTheme } : {}),
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
  const useStripe =
    !!c.env.STRIPE_SECRET_KEY && !e2eMockAllowed(c.env, c.req.header("X-E2E-Test-Mock"));

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

shops.patch("/:shopId", authMiddleware, requireShopRole("admin"), async (c) => {
  const { shopId } = c.req.param();
  const user = getUser(c);

  const body = await c.req.json<{
    name?: string;
    phone?: string;
    is_active?: number;
    commission_rate?: number;
    retail_commission_rate?: number;
  }>();

  // Commission rates are platform economics: only a developer may change
  // them — a shop admin must not be able to zero their own commission.
  for (const key of ["commission_rate", "retail_commission_rate"] as const) {
    const rate = body[key];
    if (rate === undefined) continue;
    if (user.role !== "developer") {
      return c.json({ success: false, error: `Only developers can change ${key}` }, 403);
    }
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      return c.json({ success: false, error: `${key} must be a number between 0 and 1` }, 400);
    }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); vals.push(body.name); }
  if (body.phone !== undefined) { sets.push("phone = ?"); vals.push(body.phone); }
  if (body.is_active !== undefined) { sets.push("is_active = ?"); vals.push(body.is_active); }
  if (body.commission_rate !== undefined) { sets.push("commission_rate = ?"); vals.push(body.commission_rate); }
  if (body.retail_commission_rate !== undefined) { sets.push("retail_commission_rate = ?"); vals.push(body.retail_commission_rate); }

  if (sets.length > 0) {
    vals.push(shopId);
    await c.env.DB.prepare(`UPDATE shops SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  const shop = await getShopById(c.env.DB, shopId);
  return c.json({ success: true, data: shop });
});

export default shops;
