import type { D1Database } from "@cloudflare/workers-types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DBUser {
  id: string;
  name: string | null;
  email: string;
  password_hash: string;
  role: string;
  shop_id: string | null;
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
  price: number;
  category: string | null;
  is_active: number;
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
  amount: number;
  commission: number;
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

// ─── Platform Users ───────────────────────────────────────────────────────────

export function getUserByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT * FROM platform_users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<DBUser>();
}

export function getUserById(db: D1Database, id: string) {
  return db
    .prepare("SELECT id, name, email, phone, role, shop_id, created_at FROM platform_users WHERE id = ? LIMIT 1")
    .bind(id)
    .first<Omit<DBUser, "password_hash"> & { phone?: string | null }>();
}

export function createUser(db: D1Database, user: {
  id: string;
  name?: string | null;
  email: string;
  password_hash: string;
  role: string;
  shop_id?: string | null;
}) {
  return db
    .prepare(
      "INSERT INTO platform_users (id, name, email, password_hash, role, shop_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(user.id, user.name ?? null, user.email, user.password_hash, user.role, user.shop_id ?? null)
    .run();
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
              COALESCE(SUM(CASE WHEN b.status = 'completed' THEN b.commission ELSE 0 END), 0) AS commission_total,
              (SELECT 1 FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS has_site,
              (SELECT ss.website_status FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS website_status,
              (SELECT ss.hero_image_url FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS hero_image_url,
              (SELECT ss.logo_url FROM shop_sites ss WHERE ss.shop_id = s.id AND ss.status = 'active' LIMIT 1) AS logo_url
       FROM shops s
       LEFT JOIN bookings b ON b.shop_id = s.id
       GROUP BY s.id
       ORDER BY s.shop_number`
    )
    .all<
      DBShop & {
        booking_count: number;
        commission_total: number;
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
  }
) {
  return db
    .prepare(
      `INSERT INTO shops
         (id, shop_number, slug, name, type, owner_name, owner_email, phone,
          commission_rate, status, plan, stripe_checkout_session_id, stripe_payment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      shop.commission_rate ?? 0.10,
      shop.status ?? "pending",
      shop.plan ?? "standard",
      shop.stripe_checkout_session_id ?? null,
      shop.stripe_payment_status ?? "unpaid"
    )
    .run();
}

// ─── Invites ──────────────────────────────────────────────────────────────────

export function createInvite(
  db: D1Database,
  invite: { id: string; email: string; shop_id: string; role: string; token: string; expires_at: string; active?: number }
) {
  return db
    .prepare(
      `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(invite.id, invite.email, invite.shop_id, invite.role, invite.token, invite.expires_at, invite.active ?? 1)
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
export async function ensureE2ePlaywrightInviteReady(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM platform_users WHERE email = ?").bind(E2E_PW_EMAIL).run();

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
       VALUES (?, ?, ?, 'E2E Bookable Shop', ?, 1, 'active')`
    )
    .bind(E2E_BOOKABLE_SHOP_ID, shopNumber, E2E_BOOKABLE_SLUG, "e2e-bookable@pivotparlor.internal")
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO platform_users (id, name, email, password_hash, role, shop_id)
       VALUES (?, 'E2E Stylist', ?, 'x', 'staff', ?)`
    )
    .bind(E2E_BOOKABLE_USER_ID, "e2e-bookable-staff@pivotparlor.internal", E2E_BOOKABLE_SHOP_ID)
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO staff (id, shop_id, user_id, display_name, is_active)
       VALUES (?, ?, ?, 'E2E Stylist', 1)`
    )
    .bind(E2E_BOOKABLE_STAFF_ID, E2E_BOOKABLE_SHOP_ID, E2E_BOOKABLE_USER_ID)
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO services (id, shop_id, name, duration_min, price, is_active)
       VALUES (?, ?, 'E2E Haircut', 30, 25, 1)`
    )
    .bind(E2E_BOOKABLE_SERVICE_ID, E2E_BOOKABLE_SHOP_ID)
    .run();

  for (let d = 0; d < 7; d++) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time, is_active)
         VALUES (?, ?, ?, ?, '09:00', '17:00', 1)`
      )
      .bind(`${E2E_BOOKABLE_STAFF_ID}-sch-${d}`, E2E_BOOKABLE_SHOP_ID, E2E_BOOKABLE_STAFF_ID, d)
      .run();
  }
}

export function getInviteByToken(db: D1Database, token: string) {
  return db
    .prepare("SELECT * FROM invites WHERE token = ? LIMIT 1")
    .bind(token)
    .first<DBInvite>();
}

export function markInviteUsed(db: D1Database, token: string) {
  return db
    .prepare("UPDATE invites SET used_at = datetime('now') WHERE token = ?")
    .bind(token)
    .run();
}

export function updateShopStripeSession(db: D1Database, shopId: string, checkoutSessionId: string, checkoutUrl: string | null) {
  return db
    .prepare("UPDATE shops SET stripe_checkout_session_id = ?, stripe_checkout_url = ?, stripe_payment_status = 'unpaid', status = 'awaiting_payment' WHERE id = ?")
    .bind(checkoutSessionId, checkoutUrl, shopId)
    .run();
}

export function getShopByCheckoutSessionId(db: D1Database, checkoutSessionId: string) {
  return db
    .prepare("SELECT * FROM shops WHERE stripe_checkout_session_id = ? LIMIT 1")
    .bind(checkoutSessionId)
    .first<DBShop>();
}

export function updateShopPaymentComplete(db: D1Database, shopId: string) {
  return db
    .prepare("UPDATE shops SET stripe_payment_status = 'paid', status = 'pending' WHERE id = ?")
    .bind(shopId)
    .run();
}

export function setInviteActive(db: D1Database, inviteId: string) {
  return db
    .prepare("UPDATE invites SET active = 1 WHERE id = ?")
    .bind(inviteId)
    .run();
}

export function activateShop(db: D1Database, shopId: string) {
  return db
    .prepare("UPDATE shops SET status = 'active', is_active = 1 WHERE id = ?")
    .bind(shopId)
    .run();
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
    .prepare("SELECT * FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1")
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
  }
) {
  return db
    .prepare(
      `INSERT INTO shop_sites
         (id, shop_id, template, headline, tagline, about, services_json,
          color_primary, color_accent, font_heading, font_body,
          hero_image_url, logo_url, catalog_images_json, generated_at, status,
          design_notes, owner_color_primary, owner_color_accent, website_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      site.website_status ?? "draft"
    )
    .run();
}

export function updateShopSiteWebsiteStatus(db: D1Database, shopId: string, websiteStatus: string) {
  return db
    .prepare("UPDATE shop_sites SET website_status = ? WHERE shop_id = ? AND status = 'active'")
    .bind(websiteStatus, shopId)
    .run();
}

export function updateShopSiteHeroImageUrl(db: D1Database, shopId: string, url: string) {
  return db
    .prepare("UPDATE shop_sites SET hero_image_url = ? WHERE shop_id = ? AND status = 'active'")
    .bind(url, shopId)
    .run();
}

export function updateShopSiteLogoUrl(db: D1Database, shopId: string, url: string) {
  return db
    .prepare("UPDATE shop_sites SET logo_url = ? WHERE shop_id = ? AND status = 'active'")
    .bind(url, shopId)
    .run();
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
  }
) {
  await db.prepare("DELETE FROM shop_sites WHERE shop_id = ?").bind(site.shop_id).run();
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
  job: { id: string; shop_id: string; status?: string; stage?: string }
) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO generation_jobs (id, shop_id, status, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      job.id,
      job.shop_id,
      job.status ?? "queued",
      job.stage ?? "research",
      now,
      now
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
  }
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
      "SELECT * FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY category, name"
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
  svc: { id: string; shop_id: string; name: string; duration_min: number; price: number; category?: string | null }
) {
  return db
    .prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price, category) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(svc.id, svc.shop_id, svc.name, svc.duration_min, svc.price, svc.category ?? null)
    .run();
}

export function updateService(
  db: D1Database,
  id: string,
  fields: { name?: string; duration_min?: number; price?: number; category?: string | null; is_active?: number }
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
  if (fields.duration_min !== undefined) { sets.push("duration_min = ?"); vals.push(fields.duration_min); }
  if (fields.price !== undefined) { sets.push("price = ?"); vals.push(fields.price); }
  if (fields.category !== undefined) { sets.push("category = ?"); vals.push(fields.category); }
  if (fields.is_active !== undefined) { sets.push("is_active = ?"); vals.push(fields.is_active); }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db.prepare(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

// ─── Staff ────────────────────────────────────────────────────────────────────

export async function getStaffByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      `SELECT st.*, pu.email AS user_email
       FROM staff st
       JOIN platform_users pu ON st.user_id = pu.id
       WHERE st.shop_id = ? AND st.is_active = 1
       ORDER BY st.display_name`
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
  member: { id: string; shop_id: string; user_id: string; display_name: string; bio?: string | null }
) {
  return db
    .prepare(
      "INSERT INTO staff (id, shop_id, user_id, display_name, bio) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(member.id, member.shop_id, member.user_id, member.display_name, member.bio ?? null)
    .run();
}

export function updateStaffMember(
  db: D1Database,
  id: string,
  fields: { display_name?: string; bio?: string | null; is_active?: number; avatar_url?: string | null }
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.display_name !== undefined) { sets.push("display_name = ?"); vals.push(fields.display_name); }
  if (fields.bio !== undefined) { sets.push("bio = ?"); vals.push(fields.bio); }
  if (fields.is_active !== undefined) { sets.push("is_active = ?"); vals.push(fields.is_active); }
  if (fields.avatar_url !== undefined) { sets.push("avatar_url = ?"); vals.push(fields.avatar_url); }
  if (sets.length === 0) return Promise.resolve();
  vals.push(id);
  return db.prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export function addStaffService(db: D1Database, staffId: string, serviceId: string) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO staff_services (staff_id, service_id) VALUES (?, ?)"
    )
    .bind(staffId, serviceId)
    .run();
}

export async function getStaffServices(db: D1Database, staffId: string) {
  const { results } = await db
    .prepare(
      `SELECT s.* FROM services s
       JOIN staff_services ss ON ss.service_id = s.id
       WHERE ss.staff_id = ?`
    )
    .bind(staffId)
    .all<DBService>();
  return results;
}

// ─── Schedules ────────────────────────────────────────────────────────────────

export async function getScheduleByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM schedules WHERE shop_id = ? AND is_active = 1 ORDER BY staff_id, day_of_week"
    )
    .bind(shopId)
    .all<DBSchedule>();
  return results;
}

export async function getScheduleByStaff(db: D1Database, staffId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM schedules WHERE staff_id = ? AND is_active = 1 ORDER BY day_of_week"
    )
    .bind(staffId)
    .all<DBSchedule>();
  return results;
}

export function upsertSchedule(
  db: D1Database,
  schedule: { id: string; shop_id: string; staff_id: string; day_of_week: number; start_time: string; end_time: string }
) {
  return db
    .prepare(
      `INSERT INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, is_active = 1`
    )
    .bind(
      schedule.id,
      schedule.shop_id,
      schedule.staff_id,
      schedule.day_of_week,
      schedule.start_time,
      schedule.end_time
    )
    .run();
}

export function deactivateScheduleDay(db: D1Database, staffId: string, dayOfWeek: number) {
  return db
    .prepare("UPDATE schedules SET is_active = 0 WHERE staff_id = ? AND day_of_week = ?")
    .bind(staffId, dayOfWeek)
    .run();
}

// ─── Bookings ─────────────────────────────────────────────────────────────────

export async function getBookingsByShop(
  db: D1Database,
  shopId: string,
  opts: { date?: string; staffId?: string; status?: string; limit?: number; offset?: number } = {}
) {
  const conds: string[] = ["b.shop_id = ?"];
  const vals: unknown[] = [shopId];
  if (opts.date) { conds.push("b.booking_date = ?"); vals.push(opts.date); }
  if (opts.staffId) { conds.push("b.staff_id = ?"); vals.push(opts.staffId); }
  if (opts.status) { conds.push("b.status = ?"); vals.push(opts.status); }

  // Bind LIMIT/OFFSET as parameters (never interpolate). Coerce to bounded
  // integers so a non-numeric value can never reach the SQL text.
  const rawLimit = Number(opts.limit ?? 200);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 1000)) : 200;
  const rawOffset = Number(opts.offset ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  vals.push(limit, offset);

  const sql = `
    SELECT b.*, sv.name AS service_name, sv.duration_min,
           st.display_name AS staff_name
    FROM bookings b
    JOIN services sv ON sv.id = b.service_id
    JOIN staff st ON st.id = b.staff_id
    WHERE ${conds.join(" AND ")}
    ORDER BY b.booking_date, b.start_time
    LIMIT ? OFFSET ?
  `;

  const { results } = await db.prepare(sql).bind(...vals).all<
    DBBooking & { service_name: string; duration_min: number; staff_name: string }
  >();
  return results;
}

export function getBookingById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM bookings WHERE id = ? LIMIT 1")
    .bind(id)
    .first<DBBooking>();
}

export function createBooking(db: D1Database, b: {
  id: string;
  shop_id: string;
  staff_id: string;
  service_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone?: string | null;
  booking_date: string;
  start_time: string;
  end_time: string;
  notes?: string | null;
  amount: number;
  commission: number;
}) {
  return db
    .prepare(
      `INSERT INTO bookings
         (id, shop_id, staff_id, service_id,
          customer_name, customer_email, customer_phone,
          booking_date, start_time, end_time,
          notes, amount, commission)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      b.id, b.shop_id, b.staff_id, b.service_id,
      b.customer_name, b.customer_email, b.customer_phone ?? null,
      b.booking_date, b.start_time, b.end_time,
      b.notes ?? null, b.amount, b.commission
    )
    .run();
}

export function updateBookingStatus(db: D1Database, id: string, status: string) {
  return db
    .prepare("UPDATE bookings SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
}

export function markReminderSent(db: D1Database, id: string) {
  return db
    .prepare("UPDATE bookings SET reminder_sent = 1 WHERE id = ?")
    .bind(id)
    .run();
}

export async function checkSlotConflict(
  db: D1Database,
  staffId: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  // Overlap is a pure instant-range comparison — do NOT gate on booking_date.
  // booking_date is the UTC calendar date, so an overlapping booking whose
  // instant straddles UTC midnight onto an adjacent date would be missed by a
  // single-date filter, letting two different-start bookings double-book.
  const row = await db
    .prepare(
      `SELECT 1 FROM bookings
       WHERE staff_id = ?
         AND status NOT IN ('cancelled', 'no_show')
         AND start_time < ? AND end_time > ?
       LIMIT 1`
    )
    .bind(staffId, endTime, startTime)
    .first();
  return !!row;
}

// ─── Waitlist ─────────────────────────────────────────────────────────────────

export async function getWaitlistByShop(db: D1Database, shopId: string) {
  const { results } = await db
    .prepare(
      `SELECT w.*, sv.name AS service_name
       FROM waitlist w
       LEFT JOIN services sv ON sv.id = w.service_id
       WHERE w.shop_id = ?
       ORDER BY w.created_at`
    )
    .bind(shopId)
    .all<DBWaitlist & { service_name: string | null }>();
  return results;
}

export function createWaitlistEntry(db: D1Database, entry: {
  id: string;
  shop_id: string;
  staff_id?: string | null;
  service_id?: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone?: string | null;
  preferred_date?: string | null;
}) {
  return db
    .prepare(
      `INSERT INTO waitlist
         (id, shop_id, staff_id, service_id,
          customer_name, customer_email, customer_phone, preferred_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.id, entry.shop_id, entry.staff_id ?? null, entry.service_id ?? null,
      entry.customer_name, entry.customer_email, entry.customer_phone ?? null,
      entry.preferred_date ?? null
    )
    .run();
}

// ─── Revenue helpers ──────────────────────────────────────────────────────────

export async function getRevenueByShop(
  db: D1Database,
  shopId: string,
  year: number,
  month: number
) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-31`;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS booking_count,
              COALESCE(SUM(amount), 0) AS gross,
              COALESCE(SUM(commission), 0) AS commission
       FROM bookings
       WHERE shop_id = ? AND booking_date >= ? AND booking_date <= ?
         AND status = 'completed'`
    )
    .bind(shopId, from, to)
    .first<{ booking_count: number; gross: number; commission: number }>();
  return row ?? { booking_count: 0, gross: 0, commission: 0 };
}

export async function getPlatformRevenueByMonth(db: D1Database, year: number, month: number) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-31`;
  const { results } = await db
    .prepare(
      `SELECT s.id AS shop_id, s.name AS shop_name,
              COUNT(b.id) AS booking_count,
              COALESCE(SUM(b.amount), 0) AS gross,
              COALESCE(SUM(b.commission), 0) AS commission
       FROM shops s
       LEFT JOIN bookings b ON b.shop_id = s.id
         AND b.booking_date >= ? AND b.booking_date <= ?
         AND b.status = 'completed'
       GROUP BY s.id
       ORDER BY s.shop_number`
    )
    .bind(from, to)
    .all<{
      shop_id: string;
      shop_name: string;
      booking_count: number;
      gross: number;
      commission: number;
    }>();
  return results;
}

// ─── Reminder helpers ─────────────────────────────────────────────────────────

export async function getBookingsDueForReminder(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.customer_name, b.customer_email, b.customer_phone,
              b.start_time, b.booking_date, b.notes, b.amount,
              sv.name AS service_name, sv.duration_min,
              st.display_name AS staff_name,
              sh.name AS shop_name, sh.slug AS shop_slug
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       JOIN staff st ON st.id = b.staff_id
       JOIN shops sh ON sh.id = b.shop_id
       WHERE b.status IN ('pending', 'confirmed')
         AND b.reminder_sent = 0
         AND b.booking_date = date('now', '+1 day')`
    )
    .all<{
      id: string;
      customer_name: string;
      customer_email: string;
      customer_phone: string | null;
      start_time: string;
      booking_date: string;
      notes: string | null;
      amount: number;
      service_name: string;
      duration_min: number;
      staff_name: string;
      shop_name: string;
      shop_slug: string;
    }>();
  return results;
}
