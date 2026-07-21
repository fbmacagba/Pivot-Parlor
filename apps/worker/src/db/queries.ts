import type { D1Database } from "@cloudflare/workers-types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DBUser {
  id: string;
  name: string | null;
  email: string;
  password_hash: string;
  role: string;
  shop_id: string | null;
  /** 1 once address ownership is proven (OAuth, invite accept, or verify-email link). */
  email_verified: number;
  created_at: string;
}

export interface DBShop {
  id: string;
  shop_number: number;
  slug: string;
  name: string;
  type: string;
  owner_name: string;
  owner_email: string;
  phone: string;
  commission_rate: number;
  retail_commission_rate: number;
  currency: string;
  ai_theme: string | null;
  is_active: number;
  status: string;
  plan: string;
  created_at: string;
}

export interface DBInvite {
  id: string;
  email: string;
  shop_id: string;
  role: string;
  token: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  active: number;
}

export interface DBService {
  id: string;
  shop_id: string;
  name: string;
  duration_min: number;
  price_pence: number;
  category: string | null;
  is_active: number;
  image_url: string | null;
}

export interface DBStaff {
  id: string;
  shop_id: string;
  user_id: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  is_active: number;
}

export interface DBSchedule {
  id: string;
  shop_id: string;
  staff_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: number;
}

export interface DBBooking {
  id: string;
  shop_id: string;
  staff_id: string;
  service_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  notes: string | null;
  amount_pence: number;
  commission_pence: number;
  reminder_sent: number;
  created_at: string;
}

export interface DBWaitlist {
  id: string;
  shop_id: string;
  staff_id: string | null;
  service_id: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  preferred_date: string | null;
  status: string;
  created_at: string;
}

export interface DBProductCategory {
  id: string;
  shop_id: string;
  name: string;
  sort_order: number;
  is_active: number;
  created_at: string;
}

export interface DBSupplier {
  id: string;
  shop_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  is_active: number;
  created_at: string;
}

export interface DBProduct {
  id: string;
  shop_id: string;
  category_id: string | null;
  supplier_id: string | null;
  name: string;
  description: string | null;
  brand: string | null;
  sku: string | null;
  barcode: string | null;
  cost_price_pence: number;
  retail_price_pence: number;
  tax_rate_bps: number;
  is_professional: number;
  track_stock: number;
  image_url: string | null;
  is_active: number;
  created_at: string;
}

export interface DBProductVariant {
  id: string;
  product_id: string;
  shop_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  cost_price_pence: number;
  retail_price_pence: number;
  attributes_json: string | null;
  is_active: number;
  created_at: string;
}

export interface DBStockLevel {
  id: string;
  shop_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  reorder_point: number;
  reorder_qty: number;
  updated_at: string;
}

export type StockMovementType =
  | "receive"
  | "sale"
  | "adjustment"
  | "waste"
  | "transfer"
  | "return"
  | "consumption";

export interface DBStockMovement {
  id: string;
  shop_id: string;
  product_id: string;
  variant_id: string | null;
  type: StockMovementType;
  quantity_delta: number;
  unit_cost_pence: number | null;
  reference_type: string | null;
  reference_id: string | null;
  staff_id: string | null;
  note: string | null;
  created_at: string;
}

// ─── Platform Users ───────────────────────────────────────────────────────────

export function getUserByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT * FROM platform_users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<DBUser>();
}

export function getUserById(db: D1Database, id: string) {
  return db
    .prepare(
      "SELECT id, name, email, phone, role, shop_id, email_verified, created_at FROM platform_users WHERE id = ? LIMIT 1",
    )
    .bind(id)
    .first<Omit<DBUser, "password_hash"> & { phone?: string | null }>();
}

interface NewUser {
  id: string;
  name?: string | null;
  email: string;
  password_hash: string;
  role: string;
  shop_id?: string | null;
  /** Only pass 1 when address ownership is proven (invite accept, operator-provisioned). */
  email_verified?: number;
}

/** Prepared INSERT for a new platform user — use in a db.batch() for atomicity. */
export function createUserStmt(db: D1Database, user: NewUser) {
  return db
    .prepare(
      "INSERT INTO platform_users (id, name, email, password_hash, role, shop_id, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      user.id,
      user.name ?? null,
      user.email,
      user.password_hash,
      user.role,
      user.shop_id ?? null,
      user.email_verified ?? 0,
    );
}

export function createUser(db: D1Database, user: NewUser) {
  return createUserStmt(db, user).run();
}

// ─── Shops ────────────────────────────────────────────────────────────────────

export function getShopById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM shops WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBShop>();
}

export function getShopBySlug(db: D1Database, slug: string) {
  return db
    .prepare("SELECT * FROM shops WHERE slug = ? LIMIT 1")
    .bind(slug)
    .first<DBShop>();
}

export async function getAllShops(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT s.*,
              COUNT(DISTINCT b.id)                                     AS booking_count,
              COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.commission_pence ELSE 0 END), 0) AS commission_total_pence,
              (SELECT 1 FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS has_site,
              (SELECT ss.website_status FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS website_status,
              (SELECT ss.hero_image_url FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS hero_image_url,
              (SELECT ss.logo_url FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS logo_url
       FROM shops s
       LEFT JOIN bookings b ON b.shop_id = s.id
       GROUP BY s.id
       ORDER BY s.shop_number`,
    )
    .all<
      DBShop & {
        booking_count: number;
        commission_total_pence: number;
        has_site: number | null;
        website_status: string | null;
        hero_image_url: string | null;
        logo_url: string | null;
      }
    >();
  return results;
}

export async function getNextShopNumber(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(shop_number), 0) + 1 AS next FROM shops")
    .first<{ next: number }>();
  return row?.next ?? 1;
}

export function createShop(
  db: D1Database,
  shop: {
    id: string;
    shop_number: number;
    slug: string;
    name: string;
    owner_email: string;
    type?: string;
    owner_name?: string;
    phone?: string;
    commission_rate?: number;
    status?: string;
    plan?: string;
    stripe_checkout_session_id?: string | null;
    stripe_payment_status?: string;
  },
) {
  return db
    .prepare(
      `INSERT INTO shops
         (id, shop_number, slug, name, type, owner_name, owner_email, phone,
          commission_rate, status, plan, stripe_checkout_session_id, stripe_payment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      shop.id,
      shop.shop_number,
      shop.slug,
      shop.name,
      shop.type ?? "beauty_parlor",
      shop.owner_name ?? "",
      shop.owner_email,
      shop.phone ?? "",
      shop.commission_rate ?? 0.1,
      shop.status ?? "pending",
      shop.plan ?? "standard",
      shop.stripe_checkout_session_id ?? null,
      shop.stripe_payment_status ?? "unpaid",
    )
    .run();
}

// ─── Invites ──────────────────────────────────────────────────────────────────

export function createInvite(
  db: D1Database,
  invite: {
    id: string;
    email: string;
    shop_id: string;
    role: string;
    token: string;
    expires_at: string;
    active?: number;
  },
) {
  return db
    .prepare(
      `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      invite.id,
      invite.email,
      invite.shop_id,
      invite.role,
      invite.token,
      invite.expires_at,
      invite.active ?? 1,
    )
    .run();
}

/** Matches tests/e2e/shop-onboarding-routes.ts (Playwright dev/shops POST mock). */
export const E2E_PLAYWRIGHT_INVITE_TOKEN = "a".repeat(64);

const E2E_PW_SHOP_ID = "e2e00000-0000-4000-8000-000000000001";
const E2E_PW_INVITE_ROW_ID = "e2e00000-0000-4000-8000-000000000002";
const E2E_PW_EMAIL = "e2e-playwright-invite@pivotparlor.internal";

async function ensureE2ePlaywrightShopExists(db: D1Database): Promise<void> {
  if (await getShopById(db, E2E_PW_SHOP_ID)) return;
  const slug = "e2e-playwright-invite-001";
  if (await getShopBySlug(db, slug)) return;
  const shopNumber = await getNextShopNumber(db);
  await createShop(db, {
    id: E2E_PW_SHOP_ID,
    shop_number: shopNumber,
    slug,
    name: "E2E Playwright Invite Shop",
    owner_email: E2E_PW_EMAIL,
    status: "pending",
    stripe_payment_status: "unpaid",
  });
}

/** Idempotent: reset invite + remove prior test user so accept can run again. */
export async function ensureE2ePlaywrightInviteReady(
  db: D1Database,
): Promise<void> {
  await db
    .prepare("DELETE FROM platform_users WHERE email = ?")
    .bind(E2E_PW_EMAIL)
    .run();

  await ensureE2ePlaywrightShopExists(db);

  const existing = await getInviteByToken(db, E2E_PLAYWRIGHT_INVITE_TOKEN);
  if (existing) {
    await db
      .prepare("UPDATE invites SET used_at = NULL, active = 1 WHERE token = ?")
      .bind(E2E_PLAYWRIGHT_INVITE_TOKEN)
      .run();
    return;
  }

  await createInvite(db, {
    id: E2E_PW_INVITE_ROW_ID,
    email: E2E_PW_EMAIL,
    shop_id: E2E_PW_SHOP_ID,
    role: "admin",
    token: E2E_PLAYWRIGHT_INVITE_TOKEN,
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    active: 1,
  });
}

// ─── E2E: a fully bookable fixture shop (active + service + staff + schedule) ──
// Lazily created (idempotent) when the public booking flow reads the slug under
// E2E_FIXTURES. Lets the gated booking spec complete a real booking without a
// multi-step admin setup. Cleaned by cleanup-e2e-shops (e2e-* prefix) and
// recreated fresh on next access, so each gate run starts with no bookings.
export const E2E_BOOKABLE_SLUG = "e2e-bookable-shop";
const E2E_BOOKABLE_SHOP_ID = "e2e00000-0000-4000-8000-0000000000b0";
const E2E_BOOKABLE_USER_ID = "e2e00000-0000-4000-8000-0000000000b1";
const E2E_BOOKABLE_STAFF_ID = "e2e00000-0000-4000-8000-0000000000b2";
const E2E_BOOKABLE_SERVICE_ID = "e2e00000-0000-4000-8000-0000000000b3";

export async function ensureE2eBookableShop(db: D1Database): Promise<void> {
  if (await getShopById(db, E2E_BOOKABLE_SHOP_ID)) return;

  const shopNumber = await getNextShopNumber(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO shops (id, shop_number, slug, name, owner_email, is_active, status)
       VALUES (?, ?, ?, 'E2E Bookable Shop', ?, 1, 'active')`,
    )
    .bind(
      E2E_BOOKABLE_SHOP_ID,
      shopNumber,
      E2E_BOOKABLE_SLUG,
      "e2e-bookable@pivotparlor.internal",
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO platform_users (id, name, email, password_hash, role, shop_id)
       VALUES (?, 'E2E Stylist', ?, 'x', 'staff', ?)`,
    )
    .bind(
      E2E_BOOKABLE_USER_ID,
      "e2e-bookable-staff@pivotparlor.internal",
      E2E_BOOKABLE_SHOP_ID,
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO staff (id, shop_id, user_id, display_name, is_active)
       VALUES (?, ?, ?, 'E2E Stylist', 1)`,
    )
    .bind(E2E_BOOKABLE_STAFF_ID, E2E_BOOKABLE_SHOP_ID, E2E_BOOKABLE_USER_ID)
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO services (id, shop_id, name, duration_min, price_pence, is_active)
       VALUES (?, ?, 'E2E Haircut', 30, 2500, 1)`,
    )
    .bind(E2E_BOOKABLE_SERVICE_ID, E2E_BOOKABLE_SHOP_ID)
    .run();

  for (let d = 0; d < 7; d++) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time, is_active)
         VALUES (?, ?, ?, ?, '09:00', '17:00', 1)`,
      )
      .bind(
        `${E2E_BOOKABLE_STAFF_ID}-sch-${d}`,
        E2E_BOOKABLE_SHOP_ID,
        E2E_BOOKABLE_STAFF_ID,
        d,
      )
      .run();
  }
}

export function getInviteByToken(db: D1Database, token: string) {
  return db
    .prepare("SELECT * FROM invites WHERE token = ? LIMIT 1")
    .bind(token)
    .first<DBInvite>();
}

/** Prepared UPDATE marking an invite consumed — use in a db.batch(). */
export function markInviteUsedStmt(db: D1Database, token: string) {
  return db
    .prepare("UPDATE invites SET used_at = datetime('now') WHERE token = ?")
    .bind(token);
}

export function markInviteUsed(db: D1Database, token: string) {
  return markInviteUsedStmt(db, token).run();
}

/**
 * Prepared INSERT recording that a user accepted a legal document (Article 28
 * posture, migration 043). Use in a db.batch() alongside createUserStmt so the
 * account and its acceptance record are written all-or-nothing.
 */
export function recordLegalAcceptanceStmt(
  db: D1Database,
  a: {
    id: string;
    shop_id?: string | null;
    user_id: string;
    document: string;
    version: string;
  },
) {
  return db
    .prepare(
      "INSERT INTO legal_acceptances (id, shop_id, user_id, document, version) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(a.id, a.shop_id ?? null, a.user_id, a.document, a.version);
}

export function updateShopStripeSession(
  db: D1Database,
  shopId: string,
  checkoutSessionId: string,
  checkoutUrl: string | null,
) {
  return db
    .prepare(
      "UPDATE shops SET stripe_checkout_session_id = ?, stripe_checkout_url = ?, stripe_payment_status = 'unpaid', status = 'awaiting_payment' WHERE id = ?",
    )
    .bind(checkoutSessionId, checkoutUrl, shopId)
    .run();
}

export function getShopByCheckoutSessionId(
  db: D1Database,
  checkoutSessionId: string,
) {
  return db
    .prepare("SELECT * FROM shops WHERE stripe_checkout_session_id = ? LIMIT 1")
    .bind(checkoutSessionId)
    .first<DBShop>();
}

export function updateShopPaymentComplete(db: D1Database, shopId: string) {
  return db
    .prepare(
      "UPDATE shops SET stripe_payment_status = 'paid', status = 'pending' WHERE id = ?",
    )
    .bind(shopId)
    .run();
}

export function setInviteActive(db: D1Database, inviteId: string) {
  return db
    .prepare("UPDATE invites SET active = 1 WHERE id = ?")
    .bind(inviteId)
    .run();
}

/** Prepared UPDATE activating a shop — use in a db.batch(). */
export function activateShopStmt(db: D1Database, shopId: string) {
  return db
    .prepare("UPDATE shops SET status = 'active', is_active = 1 WHERE id = ?")
    .bind(shopId);
}

export function activateShop(db: D1Database, shopId: string) {
  return activateShopStmt(db, shopId).run();
}

// ─── Shop Sites ────────────────────────────────────────────────────────────────

export interface DBShopSite {
  id: string;
  shop_id: string;
  template: string;
  headline: string | null;
  tagline: string | null;
  about: string | null;
  services_json: string | null;
  color_primary: string | null;
  color_accent: string | null;
  font_heading: string | null;
  font_body: string | null;
  hero_image_url: string | null;
  logo_url: string | null;
  catalog_images_json: string | null;
  generated_at: string | null;
  status: string;
  /** draft | live | paused */
  website_status?: string;
}

export function getShopSiteByShopId(db: D1Database, shopId: string) {
  return db
    .prepare(
      "SELECT * FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1",
    )
    .bind(shopId)
    .first<DBShopSite>();
}

export function createShopSite(
  db: D1Database,
  site: {
    id: string;
    shop_id: string;
    template: string;
    headline?: string | null;
    tagline?: string | null;
    about?: string | null;
    services_json?: string | null;
    color_primary?: string | null;
    color_accent?: string | null;
    font_heading?: string | null;
    font_body?: string | null;
    hero_image_url?: string | null;
    logo_url?: string | null;
    catalog_images_json?: string | null;
    generated_at?: string | null;
    status?: string;
    design_notes?: string | null;
    owner_color_primary?: string | null;
    owner_color_accent?: string | null;
    website_status?: string;
  },
) {
  return db
    .prepare(
      `INSERT INTO shop_sites
         (id, shop_id, template, headline, tagline, about, services_json,
          color_primary, color_accent, font_heading, font_body,
          hero_image_url, logo_url, catalog_images_json, generated_at, status,
          design_notes, owner_color_primary, owner_color_accent, website_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      site.id,
      site.shop_id,
      site.template,
      site.headline ?? null,
      site.tagline ?? null,
      site.about ?? null,
      site.services_json ?? null,
      site.color_primary ?? null,
      site.color_accent ?? null,
      site.font_heading ?? null,
      site.font_body ?? null,
      site.hero_image_url ?? null,
      site.logo_url ?? null,
      site.catalog_images_json ?? null,
      site.generated_at ?? new Date().toISOString(),
      site.status ?? "active",
      site.design_notes ?? null,
      site.owner_color_primary ?? null,
      site.owner_color_accent ?? null,
      site.website_status ?? "draft",
    )
    .run();
}

export function updateShopSiteWebsiteStatus(
  db: D1Database,
  shopId: string,
  websiteStatus: string,
) {
  return db
    .prepare(
      "UPDATE shop_sites SET website_status = ? WHERE shop_id = ? AND status = 'active'",
    )
    .bind(websiteStatus, shopId)
    .run();
}

/** Ensure the shop has a shop_sites row to write image URLs onto, creating a
 *  minimal draft row when none exists yet. */
export async function ensureDraftShopSiteRow(db: D1Database, shopId: string): Promise<void> {
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

export function updateShopSiteHeroImageUrl(
  db: D1Database,
  shopId: string,
  url: string | null,
) {
  return db
    .prepare(
      "UPDATE shop_sites SET hero_image_url = ? WHERE shop_id = ? AND status = 'active'",
    )
    .bind(url, shopId)
    .run();
}

export function updateShopSiteLogoUrl(
  db: D1Database,
  shopId: string,
  url: string | null,
) {
  return db
    .prepare(
      "UPDATE shop_sites SET logo_url = ? WHERE shop_id = ? AND status = 'active'",
    )
    .bind(url, shopId)
    .run();
}

// ─── Visual Editor (per-service image + hero/logo lock flags) ─────────────────

/** Set or clear (`null`) a service's own photo. NULL reverts the card to the AI
 *  catalog pool. Shop-scoped so a stray/foreign service id cannot write across
 *  shops. */
export function updateServiceImageUrl(
  db: D1Database,
  serviceId: string,
  shopId: string,
  url: string | null,
) {
  return db
    .prepare("UPDATE services SET image_url = ? WHERE id = ? AND shop_id = ?")
    .bind(url, serviceId, shopId)
    .run();
}

/** Mark hero/logo custom so a full-site regenerate preserves it. Idempotent;
 *  initialises a NULL column to '{}' via COALESCE. */
export function setShopSiteImageLock(
  db: D1Database,
  shopId: string,
  key: "hero" | "logo",
) {
  return db
    .prepare(
      "UPDATE shop_sites SET locked_images_json = json_set(COALESCE(locked_images_json, '{}'), ?, json('true')) WHERE shop_id = ? AND status = 'active'",
    )
    .bind(`$.${key}`, shopId)
    .run();
}

/** Unmark hero/logo (Remove) so a later regenerate may overwrite it again. */
export function clearShopSiteImageLock(
  db: D1Database,
  shopId: string,
  key: "hero" | "logo",
) {
  return db
    .prepare(
      "UPDATE shop_sites SET locked_images_json = json_remove(COALESCE(locked_images_json, '{}'), ?) WHERE shop_id = ? AND status = 'active'",
    )
    .bind(`$.${key}`, shopId)
    .run();
}

/** Read the hero/logo/catalog/lock state the Visual Editor renders. */
export function getShopSiteImages(db: D1Database, shopId: string) {
  return db
    .prepare(
      "SELECT hero_image_url, logo_url, locked_images_json, catalog_images_json FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1",
    )
    .bind(shopId)
    .first<{
      hero_image_url: string | null;
      logo_url: string | null;
      locked_images_json: string | null;
      catalog_images_json: string | null;
    }>();
}

/** Replace existing site row for shop (pipeline / regeneration). */
export async function replaceShopSiteForShop(
  db: D1Database,
  site: {
    id: string;
    shop_id: string;
    template: string;
    headline?: string | null;
    tagline?: string | null;
    about?: string | null;
    services_json?: string | null;
    color_primary?: string | null;
    color_accent?: string | null;
    font_heading?: string | null;
    font_body?: string | null;
    hero_image_url?: string | null;
    logo_url?: string | null;
    catalog_images_json?: string | null;
    generated_at?: string | null;
    status?: string;
    design_notes?: string | null;
    owner_color_primary?: string | null;
    owner_color_accent?: string | null;
    website_status?: string;
  },
) {
  await db
    .prepare("DELETE FROM shop_sites WHERE shop_id = ?")
    .bind(site.shop_id)
    .run();
  await createShopSite(db, site);
}

// ─── Generation jobs (async site pipeline) ───────────────────────────────────

export interface DBGenerationJob {
  id: string;
  shop_id: string;
  status: string;
  stage: string;
  research_output: string | null;
  build_output: string | null;
  audit_output: string | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function insertGenerationJob(
  db: D1Database,
  job: { id: string; shop_id: string; status?: string; stage?: string },
) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO generation_jobs (id, shop_id, status, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      job.id,
      job.shop_id,
      job.status ?? "queued",
      job.stage ?? "research",
      now,
      now,
    )
    .run();
}

export function getGenerationJobById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM generation_jobs WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBGenerationJob>();
}

export function updateGenerationJob(
  db: D1Database,
  id: string,
  patch: {
    status?: string;
    stage?: string;
    research_output?: string | null;
    build_output?: string | null;
    audit_output?: string | null;
    error?: string | null;
  },
) {
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [new Date().toISOString()];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.stage !== undefined) {
    sets.push("stage = ?");
    vals.push(patch.stage);
  }
  if (patch.research_output !== undefined) {
    sets.push("research_output = ?");
    vals.push(patch.research_output);
  }
  if (patch.build_output !== undefined) {
    sets.push("build_output = ?");
    vals.push(patch.build_output);
  }
  if (patch.audit_output !== undefined) {
    sets.push("audit_output = ?");
    vals.push(patch.audit_output);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  vals.push(id);
  return db
    .prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

export function setShopActive(db: D1Database, shopId: string) {
  return db
    .prepare("UPDATE shops SET status = ?, is_active = 1 WHERE id = ?")
    .bind("active", shopId)
    .run();
}

export function updateShopTheme(db: D1Database, id: string, aiTheme: string) {
  return db
    .prepare("UPDATE shops SET ai_theme = ? WHERE id = ?")
    .bind(aiTheme, id)
    .run();
}

// ─── Services ─────────────────────────────────────────────────────────────────

export async function getServicesByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY category, name",
    )
    .bind(shopId)
    .all<DBService>();
  return results;
}

export function getServiceById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM services WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBService>();
}

export function createService(
  db: D1Database,
  svc: {
    id: string;
    shop_id: string;
    name: string;
    duration_min: number;
    price_pence: number;
    category?: string | null;
  },
) {
  return db
    .prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      svc.id,
      svc.shop_id,
      svc.name,
      svc.duration_min,
      svc.price_pence,
      svc.category ?? null,
    )
    .run();
}

export function updateService(
  db: D1Database,
  id: string,
  fields: {
    name?: string;
    duration_min?: number;
    price_pence?: number;
    category?: string | null;
    is_active?: number;
  },
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.duration_min !== undefined) {
    sets.push("duration_min = ?");
    vals.push(fields.duration_min);
  }
  if (fields.price_pence !== undefined) {
    sets.push("price_pence = ?");
    vals.push(fields.price_pence);
  }
  if (fields.category !== undefined) {
    sets.push("category = ?");
    vals.push(fields.category);
  }
  if (fields.is_active !== undefined) {
    sets.push("is_active = ?");
    vals.push(fields.is_active);
  }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db
    .prepare(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

// ─── Staff ────────────────────────────────────────────────────────────────────

export async function getStaffByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      `SELECT st.*, pu.email AS user_email
       FROM staff st
       JOIN platform_users pu ON st.user_id = pu.id
       WHERE st.shop_id = ? AND st.is_active = 1
       ORDER BY st.display_name`,
    )
    .bind(shopId)
    .all<DBStaff & { user_email: string }>();
  return results;
}

export function getStaffById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM staff WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBStaff>();
}

export function createStaffMember(
  db: D1Database,
  member: {
    id: string;
    shop_id: string;
    user_id: string;
    display_name: string;
    bio?: string | null;
  },
) {
  return db
    .prepare(
      "INSERT INTO staff (id, shop_id, user_id, display_name, bio) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      member.id,
      member.shop_id,
      member.user_id,
      member.display_name,
      member.bio ?? null,
    )
    .run();
}

export function updateStaffMember(
  db: D1Database,
  id: string,
  fields: {
    display_name?: string;
    bio?: string | null;
    is_active?: number;
    avatar_url?: string | null;
  },
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.display_name !== undefined) {
    sets.push("display_name = ?");
    vals.push(fields.display_name);
  }
  if (fields.bio !== undefined) {
    sets.push("bio = ?");
    vals.push(fields.bio);
  }
  if (fields.is_active !== undefined) {
    sets.push("is_active = ?");
    vals.push(fields.is_active);
  }
  if (fields.avatar_url !== undefined) {
    sets.push("avatar_url = ?");
    vals.push(fields.avatar_url);
  }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db
    .prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

export function addStaffService(
  db: D1Database,
  staffId: string,
  serviceId: string,
) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO staff_services (staff_id, service_id) VALUES (?, ?)",
    )
    .bind(staffId, serviceId)
    .run();
}

export async function getStaffServices(db: D1Database, staffId: string) {
  const { results } = await db
    .prepare(
      `SELECT s.* FROM services s
       JOIN staff_services ss ON ss.service_id = s.id
       WHERE ss.staff_id = ?`,
    )
    .bind(staffId)
    .all<DBService>();
  return results;
}

// ─── Schedules ────────────────────────────────────────────────────────────────

export async function getScheduleByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM schedules WHERE shop_id = ? AND is_active = 1 ORDER BY staff_id, day_of_week",
    )
    .bind(shopId)
    .all<DBSchedule>();
  return results;
}

export async function getScheduleByStaff(db: D1Database, staffId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM schedules WHERE staff_id = ? AND is_active = 1 ORDER BY day_of_week",
    )
    .bind(staffId)
    .all<DBSchedule>();
  return results;
}

export function upsertSchedule(
  db: D1Database,
  schedule: {
    id: string;
    shop_id: string;
    staff_id: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
  },
) {
  return db
    .prepare(
      `INSERT INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, is_active = 1`,
    )
    .bind(
      schedule.id,
      schedule.shop_id,
      schedule.staff_id,
      schedule.day_of_week,
      schedule.start_time,
      schedule.end_time,
    )
    .run();
}

export function deactivateScheduleDay(
  db: D1Database,
  staffId: string,
  dayOfWeek: number,
) {
  return db
    .prepare(
      "UPDATE schedules SET is_active = 0 WHERE staff_id = ? AND day_of_week = ?",
    )
    .bind(staffId, dayOfWeek)
    .run();
}

// ─── Bookings ─────────────────────────────────────────────────────────────────

export async function getBookingsByShop(
  db: D1Database,
  shopId: string,
  opts: {
    date?: string;
    staffId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const conds: string[] = ["b.shop_id = ?"];
  const vals: unknown[] = [shopId];
  if (opts.date) {
    conds.push("b.booking_date = ?");
    vals.push(opts.date);
  }
  if (opts.staffId) {
    conds.push("b.staff_id = ?");
    vals.push(opts.staffId);
  }
  if (opts.status) {
    conds.push("b.status = ?");
    vals.push(opts.status);
  }

  // Bind LIMIT/OFFSET as parameters (never interpolate). Coerce to bounded
  // integers so a non-numeric value can never reach the SQL text.
  const rawLimit = Number(opts.limit ?? 200);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.trunc(rawLimit), 1000))
    : 200;
  const rawOffset = Number(opts.offset ?? 0);
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.trunc(rawOffset))
    : 0;
  vals.push(limit, offset);

  // Deposit fields (bw_* tables are owned by the booking worker, same D1) so
  // the admin UI can tell a deposit-paid booking apart and offer refund/keep
  // on cancellation. Alias bs/dt: st is taken by staff.
  const sql = `
    SELECT b.*, sv.name AS service_name, sv.duration_min,
           st.display_name AS staff_name,
           bs.deposit_amount_pence, bs.deposit_paid_at,
           dt.status AS deposit_tx_status
    FROM bookings b
    JOIN services sv ON sv.id = b.service_id
    JOIN staff st ON st.id = b.staff_id
    LEFT JOIN bw_booking_state bs ON bs.booking_id = b.id
    LEFT JOIN bw_transactions dt ON dt.booking_id = b.id AND dt.type = 'deposit'
    WHERE ${conds.join(" AND ")}
    ORDER BY b.booking_date, b.start_time
    LIMIT ? OFFSET ?
  `;

  const { results } = await db
    .prepare(sql)
    .bind(...vals)
    .all<
      DBBooking & {
        service_name: string;
        duration_min: number;
        staff_name: string;
        deposit_amount_pence: number | null;
        deposit_paid_at: string | null;
        deposit_tx_status: string | null;
      }
    >();
  return results;
}

/**
 * Deposit state for a booking (bw_* rows are written by the booking worker;
 * both workers share one D1). null when the booking has no state row — the
 * common case for plain free bookings — so cancellation forks are data-driven.
 */
export function getBookingDepositState(db: D1Database, bookingId: string, shopId: string) {
  return db
    .prepare(
      `SELECT st.deposit_paid_at, st.stripe_payment_intent_id, st.deposit_amount_pence,
              t.status AS deposit_tx_status, t.sale_id AS deposit_tx_sale_id
       FROM bw_booking_state st
       LEFT JOIN bw_transactions t ON t.booking_id = st.booking_id AND t.type = 'deposit'
       WHERE st.booking_id = ? AND st.shop_id = ? LIMIT 1`,
    )
    .bind(bookingId, shopId)
    .first<{
      deposit_paid_at: string | null;
      stripe_payment_intent_id: string | null;
      deposit_amount_pence: number | null;
      deposit_tx_status: string | null;
      deposit_tx_sale_id: string | null;
    }>();
}

export function getBookingById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM bookings WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBBooking>();
}

// createBooking moved to apps/workers/booking/src/db/queries.ts (WS-1) — the
// booking worker is the sole writer of public booking creation.

export function updateBookingStatus(
  db: D1Database,
  id: string,
  status: string,
) {
  return db
    .prepare("UPDATE bookings SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
}

/**
 * Cancel a booking only if it is still open (pending/confirmed). The caller
 * checks meta.changes: 1 means this request performed the open → cancelled
 * transition (a slot really freed, exactly once even under concurrent
 * duplicate cancels), 0 means the booking was already closed.
 */
export function cancelBookingIfOpen(db: D1Database, id: string) {
  return db
    .prepare(
      "UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'confirmed')",
    )
    .bind(id)
    .run();
}

export function markReminderSent(db: D1Database, id: string) {
  return db
    .prepare("UPDATE bookings SET reminder_sent = 1 WHERE id = ?")
    .bind(id)
    .run();
}

// checkSlotConflict moved to apps/workers/booking/src/db/queries.ts (WS-1).

// ─── Waitlist ─────────────────────────────────────────────────────────────────

export async function getWaitlistByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      `SELECT w.*, sv.name AS service_name
       FROM waitlist w
       LEFT JOIN services sv ON sv.id = w.service_id
       WHERE w.shop_id = ?
       ORDER BY w.created_at`,
    )
    .bind(shopId)
    .all<DBWaitlist & { service_name: string | null }>();
  return results;
}

export function createWaitlistEntry(
  db: D1Database,
  entry: {
    id: string;
    shop_id: string;
    staff_id?: string | null;
    service_id?: string | null;
    customer_name: string;
    customer_email: string;
    customer_phone?: string | null;
    preferred_date?: string | null;
  },
) {
  return db
    .prepare(
      `INSERT INTO waitlist
         (id, shop_id, staff_id, service_id,
          customer_name, customer_email, customer_phone, preferred_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.id,
      entry.shop_id,
      entry.staff_id ?? null,
      entry.service_id ?? null,
      entry.customer_name,
      entry.customer_email,
      entry.customer_phone ?? null,
      entry.preferred_date ?? null,
    )
    .run();
}

export function getWaitlistEntryById(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT w.*, sv.name AS service_name
       FROM waitlist w
       LEFT JOIN services sv ON sv.id = w.service_id
       WHERE w.id = ? LIMIT 1`,
    )
    .bind(id)
    .first<DBWaitlist & { service_name: string | null }>();
}

/** Atomically claim a waiting entry for notification (caller checks meta.changes). */
export function claimWaitlistNotification(db: D1Database, id: string) {
  return db
    .prepare("UPDATE waitlist SET status = 'notified' WHERE id = ? AND status = 'waiting'")
    .bind(id)
    .run();
}

/** Roll a claimed entry back to waiting when the notification email fails. */
export function revertWaitlistNotification(db: D1Database, id: string) {
  return db
    .prepare("UPDATE waitlist SET status = 'waiting' WHERE id = ? AND status = 'notified'")
    .bind(id)
    .run();
}

/**
 * Waiting entries that match a freed slot: NULL preferred_date/staff_id are
 * wildcards. Oldest first so the queue is fair; caller caps the batch.
 */
export async function getWaitingEntriesForOpenedSlot(
  db: D1Database,
  shopId: string,
  bookingDate: string,
  staffId: string,
  limit: number,
) {
  const { results } = await db
    .prepare(
      `SELECT w.*, sv.name AS service_name
       FROM waitlist w
       LEFT JOIN services sv ON sv.id = w.service_id
       WHERE w.shop_id = ? AND w.status = 'waiting'
         AND (w.preferred_date IS NULL OR w.preferred_date = ?)
         AND (w.staff_id IS NULL OR w.staff_id = ?)
       ORDER BY w.created_at
       LIMIT ?`,
    )
    .bind(shopId, bookingDate, staffId, limit)
    .all<DBWaitlist & { service_name: string | null }>();
  return results;
}

// ─── Revenue helpers ──────────────────────────────────────────────────────────

export async function getRevenueByShop(
  db: D1Database,
  shopId: string,
  year: number,
  month: number,
) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-31`;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS booking_count,
              COALESCE(SUM(amount_pence), 0) AS gross_pence,
              COALESCE(SUM(commission_pence), 0) AS commission_pence
       FROM bookings
       WHERE shop_id = ? AND booking_date >= ? AND booking_date <= ?
         AND status = 'completed'`,
    )
    .bind(shopId, from, to)
    .first<{
      booking_count: number;
      gross_pence: number;
      commission_pence: number;
    }>();
  return row ?? { booking_count: 0, gross_pence: 0, commission_pence: 0 };
}

export async function getPlatformRevenueByMonth(
  db: D1Database,
  year: number,
  month: number,
) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-31`;
  const { results } = await db
    .prepare(
      `SELECT s.id AS shop_id, s.name AS shop_name,
              COUNT(b.id) AS booking_count,
              COALESCE(SUM(b.amount_pence), 0) AS gross_pence,
              COALESCE(SUM(b.commission_pence), 0) AS commission_pence
       FROM shops s
       LEFT JOIN bookings b ON b.shop_id = s.id
         AND b.booking_date >= ? AND b.booking_date <= ?
         AND b.status = 'completed'
       GROUP BY s.id
       ORDER BY s.shop_number`,
    )
    .bind(from, to)
    .all<{
      shop_id: string;
      shop_name: string;
      booking_count: number;
      gross_pence: number;
      commission_pence: number;
    }>();
  return results;
}

// ─── Reminder helpers ─────────────────────────────────────────────────────────

// `limit` bounds one cron page so the fan-out that follows cannot approach the
// Workers subrequest ceiling. In steady state the per-booking Queue consumer
// (processReminder) sends reminders, so this catch-all should return a small
// straggler set; a full page signals the queue is not keeping up (the caller
// logs it). Reminders past the page are picked up on a later run.
export async function getBookingsDueForReminder(db: D1Database, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.customer_name, b.customer_email, b.customer_phone,
              b.start_time, b.booking_date, b.notes, b.amount_pence,
              sv.name AS service_name, sv.duration_min,
              st.display_name AS staff_name,
              sh.name AS shop_name, sh.slug AS shop_slug, sh.timezone AS shop_timezone,
              ss.address AS shop_address
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
       JOIN shops sh ON sh.id = b.shop_id
       LEFT JOIN shop_settings ss ON ss.shop_id = b.shop_id
       WHERE b.status IN ('pending', 'confirmed')
         AND b.reminder_sent = 0
         AND b.booking_date = date('now', '+1 day')
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: string;
      customer_name: string;
      customer_email: string;
      customer_phone: string | null;
      start_time: string;
      booking_date: string;
      notes: string | null;
      amount_pence: number;
      service_name: string;
      duration_min: number;
      staff_name: string;
      shop_name: string;
      shop_slug: string;
      shop_timezone: string | null;
      shop_address: string | null;
    }>();
  return results;
}

// ─── Inventory: catalogue (WS-3 Phase 0) ──────────────────────────────────────

export async function getProductCategoriesByShop(
  db: D1Database,
  shopId: string,
) {
  const { results } = await db
    .prepare(
      "SELECT * FROM product_categories WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, name",
    )
    .bind(shopId)
    .all<DBProductCategory>();
  return results;
}

export function getProductCategoryById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM product_categories WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBProductCategory>();
}

export function createProductCategory(
  db: D1Database,
  cat: { id: string; shop_id: string; name: string; sort_order?: number },
) {
  return db
    .prepare(
      "INSERT INTO product_categories (id, shop_id, name, sort_order) VALUES (?, ?, ?, ?)",
    )
    .bind(cat.id, cat.shop_id, cat.name, cat.sort_order ?? 0)
    .run();
}

export function updateProductCategory(
  db: D1Database,
  id: string,
  fields: { name?: string; sort_order?: number; is_active?: number },
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.sort_order !== undefined) {
    sets.push("sort_order = ?");
    vals.push(fields.sort_order);
  }
  if (fields.is_active !== undefined) {
    sets.push("is_active = ?");
    vals.push(fields.is_active);
  }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db
    .prepare(`UPDATE product_categories SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

export async function getSuppliersByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM suppliers WHERE shop_id = ? AND is_active = 1 ORDER BY name",
    )
    .bind(shopId)
    .all<DBSupplier>();
  return results;
}

export function getSupplierById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM suppliers WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBSupplier>();
}

export function createSupplier(
  db: D1Database,
  sup: {
    id: string;
    shop_id: string;
    name: string;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
  },
) {
  return db
    .prepare(
      "INSERT INTO suppliers (id, shop_id, name, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      sup.id,
      sup.shop_id,
      sup.name,
      sup.email ?? null,
      sup.phone ?? null,
      sup.notes ?? null,
    )
    .run();
}

export function updateSupplier(
  db: D1Database,
  id: string,
  fields: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
    is_active?: number;
  },
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.email !== undefined) {
    sets.push("email = ?");
    vals.push(fields.email);
  }
  if (fields.phone !== undefined) {
    sets.push("phone = ?");
    vals.push(fields.phone);
  }
  if (fields.notes !== undefined) {
    sets.push("notes = ?");
    vals.push(fields.notes);
  }
  if (fields.is_active !== undefined) {
    sets.push("is_active = ?");
    vals.push(fields.is_active);
  }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db
    .prepare(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

/** Products with total on-hand quantity summed across their stock rows (base + variants). */
export async function getProductsWithStockByShop(
  db: D1Database,
  shopId: string,
) {
  const { results } = await db
    .prepare(
      `SELECT p.*, COALESCE(SUM(sl.quantity), 0) AS total_quantity
       FROM products p
       LEFT JOIN stock_levels sl ON sl.product_id = p.id
       WHERE p.shop_id = ? AND p.is_active = 1
       GROUP BY p.id
       ORDER BY p.name`,
    )
    .bind(shopId)
    .all<DBProduct & { total_quantity: number }>();
  return results;
}

export function getProductById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM products WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBProduct>();
}

export function createProduct(
  db: D1Database,
  p: {
    id: string;
    shop_id: string;
    name: string;
    category_id?: string | null;
    supplier_id?: string | null;
    description?: string | null;
    brand?: string | null;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    tax_rate_bps?: number;
    is_professional?: number;
    track_stock?: number;
    image_url?: string | null;
  },
) {
  return db
    .prepare(
      `INSERT INTO products (id, shop_id, category_id, supplier_id, name, description, brand, sku, barcode,
         cost_price_pence, retail_price_pence, tax_rate_bps, is_professional, track_stock, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.shop_id,
      p.category_id ?? null,
      p.supplier_id ?? null,
      p.name,
      p.description ?? null,
      p.brand ?? null,
      p.sku ?? null,
      p.barcode ?? null,
      p.cost_price_pence ?? 0,
      p.retail_price_pence ?? 0,
      p.tax_rate_bps ?? 0,
      p.is_professional ?? 0,
      p.track_stock ?? 1,
      p.image_url ?? null,
    )
    .run();
}

export function updateProduct(
  db: D1Database,
  id: string,
  fields: {
    name?: string;
    category_id?: string | null;
    supplier_id?: string | null;
    description?: string | null;
    brand?: string | null;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    tax_rate_bps?: number;
    is_professional?: number;
    track_stock?: number;
    image_url?: string | null;
    is_active?: number;
  },
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.category_id !== undefined) {
    sets.push("category_id = ?");
    vals.push(fields.category_id);
  }
  if (fields.supplier_id !== undefined) {
    sets.push("supplier_id = ?");
    vals.push(fields.supplier_id);
  }
  if (fields.description !== undefined) {
    sets.push("description = ?");
    vals.push(fields.description);
  }
  if (fields.brand !== undefined) {
    sets.push("brand = ?");
    vals.push(fields.brand);
  }
  if (fields.sku !== undefined) {
    sets.push("sku = ?");
    vals.push(fields.sku);
  }
  if (fields.barcode !== undefined) {
    sets.push("barcode = ?");
    vals.push(fields.barcode);
  }
  if (fields.cost_price_pence !== undefined) {
    sets.push("cost_price_pence = ?");
    vals.push(fields.cost_price_pence);
  }
  if (fields.retail_price_pence !== undefined) {
    sets.push("retail_price_pence = ?");
    vals.push(fields.retail_price_pence);
  }
  if (fields.tax_rate_bps !== undefined) {
    sets.push("tax_rate_bps = ?");
    vals.push(fields.tax_rate_bps);
  }
  if (fields.is_professional !== undefined) {
    sets.push("is_professional = ?");
    vals.push(fields.is_professional);
  }
  if (fields.track_stock !== undefined) {
    sets.push("track_stock = ?");
    vals.push(fields.track_stock);
  }
  if (fields.image_url !== undefined) {
    sets.push("image_url = ?");
    vals.push(fields.image_url);
  }
  if (fields.is_active !== undefined) {
    sets.push("is_active = ?");
    vals.push(fields.is_active);
  }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db
    .prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

export async function getVariantsByProduct(db: D1Database, productId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY name",
    )
    .bind(productId)
    .all<DBProductVariant>();
  return results;
}

export function getProductVariantById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM product_variants WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBProductVariant>();
}

export function createProductVariant(
  db: D1Database,
  v: {
    id: string;
    product_id: string;
    shop_id: string;
    name: string;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    attributes_json?: string | null;
  },
) {
  return db
    .prepare(
      `INSERT INTO product_variants (id, product_id, shop_id, name, sku, barcode,
         cost_price_pence, retail_price_pence, attributes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      v.id,
      v.product_id,
      v.shop_id,
      v.name,
      v.sku ?? null,
      v.barcode ?? null,
      v.cost_price_pence ?? 0,
      v.retail_price_pence ?? 0,
      v.attributes_json ?? null,
    )
    .run();
}

export function updateProductVariant(
  db: D1Database,
  id: string,
  fields: {
    name?: string;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    attributes_json?: string | null;
    is_active?: number;
  },
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    vals.push(fields.name);
  }
  if (fields.sku !== undefined) {
    sets.push("sku = ?");
    vals.push(fields.sku);
  }
  if (fields.barcode !== undefined) {
    sets.push("barcode = ?");
    vals.push(fields.barcode);
  }
  if (fields.cost_price_pence !== undefined) {
    sets.push("cost_price_pence = ?");
    vals.push(fields.cost_price_pence);
  }
  if (fields.retail_price_pence !== undefined) {
    sets.push("retail_price_pence = ?");
    vals.push(fields.retail_price_pence);
  }
  if (fields.attributes_json !== undefined) {
    sets.push("attributes_json = ?");
    vals.push(fields.attributes_json);
  }
  if (fields.is_active !== undefined) {
    sets.push("is_active = ?");
    vals.push(fields.is_active);
  }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db
    .prepare(`UPDATE product_variants SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
}

// ─── Inventory: stock (WS-3 Phase 0) ──────────────────────────────────────────
//
// stock_levels is the current quantity; stock_movements is the append-only
// audit trail. Every quantity change goes through applyStockMovement, which
// writes both rows in one atomic D1 batch — never UPDATE stock_levels.quantity
// directly. The paired ON CONFLICT targets match the two partial unique
// indexes from migration 034 (variant vs no-variant rows).

export interface StockMovementInput {
  id: string;
  shop_id: string;
  product_id: string;
  variant_id?: string | null;
  type: StockMovementType;
  quantity_delta: number;
  unit_cost_pence?: number | null;
  reference_type?: string | null;
  reference_id?: string | null;
  staff_id?: string | null;
  note?: string | null;
}

/**
 * The movement + level-upsert statement pair, for callers that need several
 * movements inside ONE db.batch (PO receiving, stock-take close). Single
 * movements should keep using applyStockMovement.
 */
export function stockMovementStatements(db: D1Database, m: StockMovementInput) {
  const variantId = m.variant_id ?? null;
  const movement = db
    .prepare(
      `INSERT INTO stock_movements (id, shop_id, product_id, variant_id, type, quantity_delta,
         unit_cost_pence, reference_type, reference_id, staff_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      m.id,
      m.shop_id,
      m.product_id,
      variantId,
      m.type,
      m.quantity_delta,
      m.unit_cost_pence ?? null,
      m.reference_type ?? null,
      m.reference_id ?? null,
      m.staff_id ?? null,
      m.note ?? null,
    );
  const level =
    variantId === null
      ? db
          .prepare(
            `INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity)
             VALUES (?, ?, ?, NULL, ?)
             ON CONFLICT(shop_id, product_id) WHERE variant_id IS NULL
             DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = datetime('now')`,
          )
          .bind(crypto.randomUUID(), m.shop_id, m.product_id, m.quantity_delta)
      : db
          .prepare(
            `INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(shop_id, product_id, variant_id) WHERE variant_id IS NOT NULL
             DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = datetime('now')`,
          )
          .bind(
            crypto.randomUUID(),
            m.shop_id,
            m.product_id,
            variantId,
            m.quantity_delta,
          );
  return [movement, level];
}

export async function applyStockMovement(
  db: D1Database,
  m: StockMovementInput,
) {
  await db.batch(stockMovementStatements(db, m));
}

/** Reorder thresholds are configuration, not stock: set them without a movement row. */
export function setReorderLevels(
  db: D1Database,
  args: {
    shop_id: string;
    product_id: string;
    variant_id?: string | null;
    reorder_point: number;
    reorder_qty: number;
  },
) {
  const variantId = args.variant_id ?? null;
  if (variantId === null) {
    return db
      .prepare(
        `INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity, reorder_point, reorder_qty)
         VALUES (?, ?, ?, NULL, 0, ?, ?)
         ON CONFLICT(shop_id, product_id) WHERE variant_id IS NULL
         DO UPDATE SET reorder_point = excluded.reorder_point, reorder_qty = excluded.reorder_qty,
                       updated_at = datetime('now')`,
      )
      .bind(
        crypto.randomUUID(),
        args.shop_id,
        args.product_id,
        args.reorder_point,
        args.reorder_qty,
      )
      .run();
  }
  return db
    .prepare(
      `INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity, reorder_point, reorder_qty)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(shop_id, product_id, variant_id) WHERE variant_id IS NOT NULL
       DO UPDATE SET reorder_point = excluded.reorder_point, reorder_qty = excluded.reorder_qty,
                     updated_at = datetime('now')`,
    )
    .bind(
      crypto.randomUUID(),
      args.shop_id,
      args.product_id,
      variantId,
      args.reorder_point,
      args.reorder_qty,
    )
    .run();
}

export async function getStockLevelsByProduct(
  db: D1Database,
  shopId: string,
  productId: string,
) {
  const { results } = await db
    .prepare(
      `SELECT sl.*, v.name AS variant_name
       FROM stock_levels sl
       LEFT JOIN product_variants v ON v.id = sl.variant_id
       WHERE sl.shop_id = ? AND sl.product_id = ?
       ORDER BY v.name`,
    )
    .bind(shopId, productId)
    .all<DBStockLevel & { variant_name: string | null }>();
  return results;
}

/**
 * Low stock = tracked, active products whose stock row is out (<= 0) or at/under
 * its reorder point (when one is configured).
 */
export async function getLowStockByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      `SELECT sl.*, p.name AS product_name, p.sku AS product_sku, v.name AS variant_name
       FROM stock_levels sl
       JOIN products p ON p.id = sl.product_id
       LEFT JOIN product_variants v ON v.id = sl.variant_id
       WHERE sl.shop_id = ?
         AND p.is_active = 1 AND p.track_stock = 1
         AND (sl.quantity <= 0 OR (sl.reorder_point > 0 AND sl.quantity <= sl.reorder_point))
       ORDER BY sl.quantity ASC`,
    )
    .bind(shopId)
    .all<
      DBStockLevel & {
        product_name: string;
        product_sku: string | null;
        variant_name: string | null;
      }
    >();
  return results;
}

export async function getStockMovementsByShop(
  db: D1Database,
  shopId: string,
  opts: { product_id?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const vals: unknown[] = [shopId];
  let where = "m.shop_id = ?";
  if (opts.product_id) {
    where += " AND m.product_id = ?";
    vals.push(opts.product_id);
  }
  vals.push(limit);
  const { results } = await db
    .prepare(
      `SELECT m.*, p.name AS product_name, v.name AS variant_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN product_variants v ON v.id = m.variant_id
       WHERE ${where}
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .bind(...vals)
    .all<
      DBStockMovement & { product_name: string; variant_name: string | null }
    >();
  return results;
}

// ─── Inventory: purchasing + stock-takes + BOM (WS-3 Phase 2, migration 038) ──

export interface DBPurchaseOrder {
  id: string;
  shop_id: string;
  supplier_id: string | null;
  status: "draft" | "ordered" | "partial" | "received" | "cancelled";
  notes: string | null;
  ordered_at: string | null;
  received_at: string | null;
  created_at: string;
}

export interface DBPurchaseOrderItem {
  id: string;
  po_id: string;
  shop_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  received_qty: number;
  unit_cost_pence: number;
  created_at: string;
}

export interface DBStockTake {
  id: string;
  shop_id: string;
  status: "open" | "completed" | "cancelled";
  notes: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DBStockTakeItem {
  id: string;
  stock_take_id: string;
  shop_id: string;
  product_id: string;
  variant_id: string | null;
  expected_qty: number;
  counted_qty: number;
  created_at: string;
}

/** Headers with supplier name and item-derived totals (never stored — cannot drift). */
export async function getPurchaseOrdersByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      `SELECT po.*, s.name AS supplier_name,
              COALESCE(SUM(i.quantity * i.unit_cost_pence), 0) AS total_pence,
              COALESCE(SUM(i.quantity), 0) AS total_qty,
              COALESCE(SUM(i.received_qty), 0) AS total_received_qty
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN purchase_order_items i ON i.po_id = po.id
       WHERE po.shop_id = ?
       GROUP BY po.id
       ORDER BY po.created_at DESC
       LIMIT 100`,
    )
    .bind(shopId)
    .all<
      DBPurchaseOrder & {
        supplier_name: string | null;
        total_pence: number;
        total_qty: number;
        total_received_qty: number;
      }
    >();
  return results;
}

export function getPurchaseOrderById(
  db: D1Database,
  shopId: string,
  poId: string,
) {
  return db
    .prepare(
      "SELECT * FROM purchase_orders WHERE id = ? AND shop_id = ? LIMIT 1",
    )
    .bind(poId, shopId)
    .first<DBPurchaseOrder>();
}

export async function getPurchaseOrderItems(db: D1Database, poId: string) {
  const { results } = await db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.sku AS product_sku, v.name AS variant_name
       FROM purchase_order_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN product_variants v ON v.id = i.variant_id
       WHERE i.po_id = ?
       ORDER BY p.name`,
    )
    .bind(poId)
    .all<
      DBPurchaseOrderItem & {
        product_name: string;
        product_sku: string | null;
        variant_name: string | null;
      }
    >();
  return results;
}

/** BOM rows for one service, joined with the product facts the UI needs. */
export async function getServiceProducts(
  db: D1Database,
  shopId: string,
  serviceId: string,
) {
  const { results } = await db
    .prepare(
      `SELECT sp.service_id, sp.product_id, sp.quantity, p.name AS product_name,
              p.cost_price_pence, p.track_stock, p.is_professional
       FROM service_products sp
       JOIN products p ON p.id = sp.product_id
       WHERE sp.shop_id = ? AND sp.service_id = ?
       ORDER BY p.name`,
    )
    .bind(shopId, serviceId)
    .all<{
      service_id: string;
      product_id: string;
      quantity: number;
      product_name: string;
      cost_price_pence: number;
      track_stock: number;
      is_professional: number;
    }>();
  return results;
}

/** Replace a service's BOM wholesale — delete + insert in one batch. */
export async function setServiceProducts(
  db: D1Database,
  shopId: string,
  serviceId: string,
  entries: Array<{ product_id: string; quantity: number }>,
) {
  const stmts = [
    db
      .prepare(
        "DELETE FROM service_products WHERE shop_id = ? AND service_id = ?",
      )
      .bind(shopId, serviceId),
    ...entries.map((e) =>
      db
        .prepare(
          "INSERT INTO service_products (service_id, product_id, shop_id, quantity) VALUES (?, ?, ?, ?)",
        )
        .bind(serviceId, e.product_id, shopId, e.quantity),
    ),
  ];
  await db.batch(stmts);
}

export function getStockTakeById(
  db: D1Database,
  shopId: string,
  stockTakeId: string,
) {
  return db
    .prepare("SELECT * FROM stock_takes WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(stockTakeId, shopId)
    .first<DBStockTake>();
}

export async function getStockTakesByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      `SELECT st.*, COUNT(i.id) AS item_count,
              COALESCE(SUM(i.counted_qty - i.expected_qty), 0) AS variance_qty
       FROM stock_takes st
       LEFT JOIN stock_take_items i ON i.stock_take_id = st.id
       WHERE st.shop_id = ?
       GROUP BY st.id
       ORDER BY st.created_at DESC
       LIMIT 50`,
    )
    .bind(shopId)
    .all<DBStockTake & { item_count: number; variance_qty: number }>();
  return results;
}

export async function getStockTakeItems(db: D1Database, stockTakeId: string) {
  const { results } = await db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.sku AS product_sku, v.name AS variant_name
       FROM stock_take_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN product_variants v ON v.id = i.variant_id
       WHERE i.stock_take_id = ?
       ORDER BY p.name`,
    )
    .bind(stockTakeId)
    .all<
      DBStockTakeItem & {
        product_name: string;
        product_sku: string | null;
        variant_name: string | null;
      }
    >();
  return results;
}

/** Current on-hand quantity for one product/variant (0 when no level row exists). */
export async function getCurrentQuantity(
  db: D1Database,
  shopId: string,
  productId: string,
  variantId: string | null,
): Promise<number> {
  const row =
    variantId === null
      ? await db
          .prepare(
            "SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL LIMIT 1",
          )
          .bind(shopId, productId)
          .first<{ quantity: number }>()
      : await db
          .prepare(
            "SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id = ? LIMIT 1",
          )
          .bind(shopId, productId, variantId)
          .first<{ quantity: number }>();
  return row?.quantity ?? 0;
}

/**
 * Retail/COGS report over the sale_items snapshots (WS-3 Phase 2). Voided
 * sales are excluded; refund adjustments arrive with the returns work.
 * Dates are inclusive YYYY-MM-DD, matched on substr(created_at, 1, 10).
 */
export async function getInventoryReport(
  db: D1Database,
  shopId: string,
  from: string,
  to: string,
) {
  const [summary, byProduct, byStaff, consumption] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(SUM(si.line_total_pence), 0) AS retail_revenue_pence,
                COALESCE(SUM(si.cost_price_pence * si.quantity), 0) AS cogs_pence,
                COALESCE(SUM(si.quantity), 0) AS units_sold
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.shop_id = ? AND si.item_type = 'product'
           AND s.status != 'voided'
           AND substr(s.created_at, 1, 10) BETWEEN ? AND ?`,
      )
      .bind(shopId, from, to)
      .first<{
        retail_revenue_pence: number;
        cogs_pence: number;
        units_sold: number;
      }>(),
    db
      .prepare(
        `SELECT si.product_id, si.name,
                SUM(si.quantity) AS units_sold,
                SUM(si.line_total_pence) AS revenue_pence,
                SUM(si.cost_price_pence * si.quantity) AS cogs_pence
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.shop_id = ? AND si.item_type = 'product'
           AND s.status != 'voided'
           AND substr(s.created_at, 1, 10) BETWEEN ? AND ?
         GROUP BY si.product_id, si.name
         ORDER BY revenue_pence DESC
         LIMIT 50`,
      )
      .bind(shopId, from, to)
      .all<{
        product_id: string | null;
        name: string;
        units_sold: number;
        revenue_pence: number;
        cogs_pence: number;
      }>(),
    db
      .prepare(
        `SELECT si.staff_id, st.display_name AS staff_name,
                SUM(si.quantity) AS units_sold,
                SUM(si.line_total_pence) AS revenue_pence
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN staff st ON st.id = si.staff_id
         WHERE si.shop_id = ? AND si.item_type = 'product'
           AND s.status != 'voided'
           AND substr(s.created_at, 1, 10) BETWEEN ? AND ?
         GROUP BY si.staff_id
         ORDER BY revenue_pence DESC`,
      )
      .bind(shopId, from, to)
      .all<{
        staff_id: string | null;
        staff_name: string | null;
        units_sold: number;
        revenue_pence: number;
      }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(-m.quantity_delta), 0) AS units_consumed,
                COALESCE(SUM(-m.quantity_delta * COALESCE(m.unit_cost_pence, 0)), 0) AS cost_pence
         FROM stock_movements m
         WHERE m.shop_id = ? AND m.type = 'consumption'
           AND substr(m.created_at, 1, 10) BETWEEN ? AND ?`,
      )
      .bind(shopId, from, to)
      .first<{ units_consumed: number; cost_pence: number }>(),
  ]);

  return {
    retail: {
      revenue_pence: summary?.retail_revenue_pence ?? 0,
      cogs_pence: summary?.cogs_pence ?? 0,
      margin_pence:
        (summary?.retail_revenue_pence ?? 0) - (summary?.cogs_pence ?? 0),
      units_sold: summary?.units_sold ?? 0,
    },
    by_product: byProduct.results ?? [],
    by_staff: (byStaff.results ?? []).filter((r) => r.staff_id !== null),
    consumption: {
      units_consumed: consumption?.units_consumed ?? 0,
      cost_pence: consumption?.cost_pence ?? 0,
    },
  };
}

// ─── WS-8 / LEG-6: time-based retention ──────────────────────────────────────
// Every sweep is bounded per run (no unbounded fan-out on a cron — the WS-7
// parity-gap lesson) and idempotent. The retention WINDOWS are policy and live
// in services/retention.ts; these helpers only implement the SQL. Financial
// rows (bw_transactions, bw_commission_ledger, sales) are deliberately NOT
// touched: UK financial-record retention outlives every window here.

/** Visitor chat transcripts contain free text; delete whole sessions. */
export async function deleteExpiredChatSessions(
  db: D1Database,
  olderThanDays: number,
  limit: number,
) {
  const r = await db
    .prepare(
      `DELETE FROM chat_sessions WHERE id IN (
         SELECT id FROM chat_sessions WHERE updated_at < datetime('now', ?) LIMIT ?)`,
    )
    .bind(`-${olderThanDays} days`, limit)
    .run();
  return r.meta.changes ?? 0;
}

/** Waitlist rows are operational; anything this old is finished or abandoned. */
export async function deleteStaleWaitlist(
  db: D1Database,
  olderThanDays: number,
  limit: number,
) {
  const r = await db
    .prepare(
      `DELETE FROM waitlist WHERE id IN (
         SELECT id FROM waitlist WHERE created_at < datetime('now', ?) LIMIT ?)`,
    )
    .bind(`-${olderThanDays} days`, limit)
    .run();
  return r.meta.changes ?? 0;
}

/** Used or expired invites past the grace window (email + live token hygiene). */
export async function deleteExpiredInvites(
  db: D1Database,
  graceDays: number,
  limit: number,
) {
  const r = await db
    .prepare(
      `DELETE FROM invites WHERE id IN (
         SELECT id FROM invites
         WHERE (used_at IS NOT NULL AND used_at < datetime('now', ?))
            OR expires_at < datetime('now', ?)
         LIMIT ?)`,
    )
    .bind(`-${graceDays} days`, `-${graceDays} days`, limit)
    .run();
  return r.meta.changes ?? 0;
}

/** Marketing enquiries that never onboarded; onboarded contacts are a
 *  business relationship record and are kept. */
export async function deleteStaleContacts(
  db: D1Database,
  olderThanMonths: number,
  limit: number,
) {
  const r = await db
    .prepare(
      `DELETE FROM contacts WHERE id IN (
         SELECT id FROM contacts
         WHERE onboarded_at IS NULL AND shop_id IS NULL
           AND created_at < datetime('now', ?)
         LIMIT ?)`,
    )
    .bind(`-${olderThanMonths} months`, limit)
    .run();
  return r.meta.changes ?? 0;
}

export const REDACTED_NAME = "[redacted]";
export const REDACTED_EMAIL = "redacted@retention.invalid";

/** Anonymise booking PII in place: the row (and its money fields) stays for
 *  reports and the financial audit trail; name/email/phone/notes go. The
 *  email marker makes the sweep idempotent and keeps already-anonymised rows
 *  out of later scans. */
export async function anonymiseOldBookings(
  db: D1Database,
  olderThanMonths: number,
  limit: number,
) {
  const r = await db
    .prepare(
      `UPDATE bookings
       SET customer_name = ?, customer_email = ?, customer_phone = NULL, notes = NULL
       WHERE id IN (
         SELECT id FROM bookings
         WHERE booking_date < date('now', ?)
           AND customer_email != ?
         LIMIT ?)`,
    )
    .bind(
      REDACTED_NAME,
      REDACTED_EMAIL,
      `-${olderThanMonths} months`,
      REDACTED_EMAIL,
      limit,
    )
    .run();
  return r.meta.changes ?? 0;
}

/** AI usage rows are ops metrics only (tokens/cost, no PII); pruned for size. */
export async function pruneAiUsageLog(
  db: D1Database,
  olderThanMonths: number,
  limit: number,
) {
  const r = await db
    .prepare(
      `DELETE FROM ai_usage_log WHERE id IN (
         SELECT id FROM ai_usage_log WHERE created_at < datetime('now', ?) LIMIT ?)`,
    )
    .bind(`-${olderThanMonths} months`, limit)
    .run();
  return r.meta.changes ?? 0;
}
