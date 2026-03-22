/**
 * pivot-parlor-builder — Consumes site-assemble-queue: writes shop_sites, shop_pages, shop_settings → site-audit-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITE_AUDIT_QUEUE: Queue;
  ENVIRONMENT: string;
}

const LAYOUT_MOOD_TO_TEMPLATE: Record<string, string> = {
  "luxury-dark": "luxury",
  "modern-minimal": "minimal",
  "bold-vibrant": "vibrant",
  "warm-editorial": "editorial",
  "classic-traditional": "classic",
  "fresh-pastel": "fresh",
};

export interface AssembleQueueMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
  shopName: string;
  shopType: string;
  hasLogoFile: boolean;
  imageUrls: {
    hero: string;
    logo: string;
    catalog: string[];
  };
  researchOutput: Record<string, unknown>;
}

export interface AuditQueueMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
  shopName: string;
}

interface NormalizedResearch {
  palette: {
    primary: string;
    accent: string;
    background: string;
    text: string;
    muted: string;
  };
  typography: {
    heading_font: string;
    body_font: string;
    heading_weight: string;
    heading_style: string;
  };
  layout_mood: string;
  brand_voice: string;
  content: {
    headline: string;
    subheadline: string;
    hero_cta: string;
    about_title: string;
    about_body: string;
    trust_signals: string[];
    unique_selling_points: string[];
    seo_title: string;
    seo_description: string;
  };
  legal_content: {
    privacy_policy: string;
    terms_of_service: string;
    cookie_policy: string;
  };
  social_stubs: {
    instagram_url: string;
    facebook_url: string;
    tiktok_url: string;
    twitter_url: string;
    youtube_url: string;
    whatsapp_url: string;
    linkedin_url: string;
  };
}

function jobKvKey(jobId: string): string {
  return `job:${jobId}`;
}

async function putJobKv(kv: KVNamespace, jobId: string, data: Record<string, unknown>): Promise<void> {
  await kv.put(jobKvKey(jobId), JSON.stringify(data));
}

async function updateGenerationJob(
  db: D1Database,
  id: string,
  patch: { status?: string; stage?: string; error?: string | null }
): Promise<void> {
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
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  vals.push(id);
  await db.prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

function d1Rows<T>(r: unknown): T[] {
  if (r && typeof r === "object" && "results" in r && Array.isArray((r as { results: T[] }).results)) {
    return (r as { results: T[] }).results;
  }
  return [];
}

async function getTableColumnNames(db: D1Database, table: "shop_sites"): Promise<Set<string>> {
  const r = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const rows = d1Rows<{ name: string }>(r);
  return new Set(rows.map((row) => row.name));
}

async function ensureShopSitesExtraColumns(db: D1Database): Promise<void> {
  let cols = await getTableColumnNames(db, "shop_sites");
  const tryAdd = async (name: string, ddl: string) => {
    if (cols.has(name)) return;
    try {
      await db.prepare(`ALTER TABLE shop_sites ADD COLUMN ${name} ${ddl}`).run();
      cols.add(name);
    } catch (e) {
      console.error(`[pivot-parlor-builder] ALTER shop_sites ADD ${name} failed`, e);
    }
  };
  await tryAdd("trust_signals_json", "TEXT");
  await tryAdd("usps_json", "TEXT");
  await tryAdd("seo_title", "TEXT");
  await tryAdd("seo_description", "TEXT");
  await tryAdd("layout_mood", "TEXT");
  await tryAdd("brand_voice", "TEXT");
}

async function ensureShopPagesTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS shop_pages (
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        page_type TEXT NOT NULL,
        content TEXT,
        generated_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (shop_id, page_type)
      )`
    )
    .run();
}

async function ensureShopSettingsTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS shop_settings (
        shop_id TEXT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
        instagram_url TEXT DEFAULT '',
        show_instagram INTEGER NOT NULL DEFAULT 0,
        facebook_url TEXT DEFAULT '',
        show_facebook INTEGER NOT NULL DEFAULT 0,
        tiktok_url TEXT DEFAULT '',
        show_tiktok INTEGER NOT NULL DEFAULT 0,
        twitter_url TEXT DEFAULT '',
        show_twitter INTEGER NOT NULL DEFAULT 0,
        youtube_url TEXT DEFAULT '',
        show_youtube INTEGER NOT NULL DEFAULT 0,
        whatsapp_url TEXT DEFAULT '',
        show_whatsapp INTEGER NOT NULL DEFAULT 0,
        linkedin_url TEXT DEFAULT '',
        show_linkedin INTEGER NOT NULL DEFAULT 0,
        commission_bearer TEXT NOT NULL DEFAULT 'shop',
        product_commission_enabled INTEGER NOT NULL DEFAULT 0
      )`
    )
    .run();
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strArr(v: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.filter((x): x is string => typeof x === "string");
}

function normalizeResearch(ro: Record<string, unknown>): NormalizedResearch {
  const paletteIn = ro.palette as Record<string, unknown> | undefined;
  const typoIn = ro.typography as Record<string, unknown> | undefined;
  const contentIn = ro.content as Record<string, unknown> | undefined;
  const legalIn = ro.legal_content as Record<string, unknown> | undefined;
  const socialIn = ro.social_stubs as Record<string, unknown> | undefined;

  const palette = {
    primary: str(paletteIn?.primary, str(ro.color_primary, "#1a1a1a")),
    accent: str(paletteIn?.accent, str(ro.color_accent, "#C9A84C")),
    background: str(paletteIn?.background, "#0D0D0D"),
    text: str(paletteIn?.text, "#f5f5f5"),
    muted: str(paletteIn?.muted, "rgba(255,255,255,0.6)"),
  };

  const typography = {
    heading_font: str(typoIn?.heading_font, str(ro.font_heading, "Playfair Display")),
    body_font: str(typoIn?.body_font, str(ro.font_body, "DM Sans")),
    heading_weight: str(typoIn?.heading_weight, "700"),
    heading_style: str(typoIn?.heading_style, "serif"),
  };

  const layout_mood = str(ro.layout_mood, "modern-minimal");
  const brand_voice = str(ro.brand_voice, str(ro.positioning, ""));

  const content = {
    headline: str(contentIn?.headline, str(ro.headline, "")),
    subheadline: str(contentIn?.subheadline, str(ro.subheadline, "")),
    hero_cta: str(contentIn?.hero_cta, str(ro.hero_cta, "Book now")),
    about_title: str(contentIn?.about_title, str(ro.about_title, "About us")),
    about_body: str(contentIn?.about_body, str(ro.about_body, "")),
    trust_signals: strArr(contentIn?.trust_signals, strArr(ro.trust_signals as unknown[], ["", "", ""])),
    unique_selling_points: strArr(
      contentIn?.unique_selling_points,
      strArr(ro.unique_selling_points as unknown[], ["", "", ""])
    ),
    seo_title: str(contentIn?.seo_title, str(ro.seo_title, "")),
    seo_description: str(contentIn?.seo_description, str(ro.seo_description, "")),
  };

  const legal_content = {
    privacy_policy: str(legalIn?.privacy_policy, ""),
    terms_of_service: str(legalIn?.terms_of_service, ""),
    cookie_policy: str(legalIn?.cookie_policy, ""),
  };

  const social_stubs = {
    instagram_url: str(socialIn?.instagram_url, ""),
    facebook_url: str(socialIn?.facebook_url, ""),
    tiktok_url: str(socialIn?.tiktok_url, ""),
    twitter_url: str(socialIn?.twitter_url, ""),
    youtube_url: str(socialIn?.youtube_url, ""),
    whatsapp_url: str(socialIn?.whatsapp_url, ""),
    linkedin_url: str(socialIn?.linkedin_url, ""),
  };

  return {
    palette,
    typography,
    layout_mood,
    brand_voice,
    content,
    legal_content,
    social_stubs,
  };
}

function templateFromLayoutMood(layoutMood: string): string {
  return LAYOUT_MOOD_TO_TEMPLATE[layoutMood] ?? "minimal";
}

function parseInput(body: unknown): AssembleQueueMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string" || typeof o.shopSlug !== "string") return null;
  if (typeof o.shopName !== "string" || typeof o.shopType !== "string") return null;
  if (typeof o.hasLogoFile !== "boolean") return null;
  const iu = o.imageUrls;
  if (!iu || typeof iu !== "object") return null;
  const urls = iu as Record<string, unknown>;
  if (typeof urls.hero !== "string" || typeof urls.logo !== "string" || !Array.isArray(urls.catalog)) return null;
  if (!urls.catalog.every((x) => typeof x === "string")) return null;
  if (!o.researchOutput || typeof o.researchOutput !== "object") return null;
  return {
    jobId: o.jobId,
    shopId: o.shopId,
    shopSlug: o.shopSlug,
    shopName: o.shopName,
    shopType: o.shopType,
    hasLogoFile: o.hasLogoFile,
    imageUrls: {
      hero: urls.hero,
      logo: urls.logo,
      catalog: urls.catalog as string[],
    },
    researchOutput: o.researchOutput as Record<string, unknown>,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchServicesJson(db: D1Database, shopId: string): Promise<string> {
  const r = await db
    .prepare("SELECT * FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY category, name")
    .bind(shopId)
    .all<Record<string, unknown>>();
  return JSON.stringify(d1Rows<Record<string, unknown>>(r));
}

async function processOneMessage(body: unknown, env: Env): Promise<void> {
  const input = parseInput(body);
  if (!input) {
    console.error("[pivot-parlor-builder] Invalid assemble message", body);
    return;
  }

  const { jobId, shopId, shopSlug, shopName, hasLogoFile, imageUrls, researchOutput } = input;

  try {
    const spec = normalizeResearch(researchOutput);
    const template = templateFromLayoutMood(spec.layout_mood);
    const now = new Date().toISOString();

    await ensureShopSitesExtraColumns(env.DB);
    await ensureShopPagesTable(env.DB);
    await ensureShopSettingsTable(env.DB);

    const servicesJson = await fetchServicesJson(env.DB, shopId);
    const siteId = crypto.randomUUID();
    const logoUrl = hasLogoFile ? "" : imageUrls.logo || "";
    const catalogJson = JSON.stringify(imageUrls.catalog);
    const trustJson = JSON.stringify(spec.content.trust_signals);
    const uspsJson = JSON.stringify(spec.content.unique_selling_points);

    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO shop_sites (
          id, shop_id, template, headline, tagline, about, services_json,
          color_primary, color_accent, font_heading, font_body,
          hero_image_url, logo_url, catalog_images_json, generated_at, status,
          design_notes, owner_color_primary, owner_color_accent,
          trust_signals_json, usps_json, seo_title, seo_description, layout_mood, brand_voice
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        siteId,
        shopId,
        template,
        spec.content.headline,
        spec.content.subheadline,
        spec.content.about_body,
        servicesJson,
        spec.palette.primary,
        spec.palette.accent,
        spec.typography.heading_font,
        spec.typography.body_font,
        imageUrls.hero || "",
        logoUrl,
        catalogJson,
        now,
        "active",
        spec.brand_voice,
        null,
        null,
        trustJson,
        uspsJson,
        spec.content.seo_title,
        spec.content.seo_description,
        spec.layout_mood,
        spec.brand_voice
      )
      .run();

    const pages: Array<{ type: string; content: string }> = [
      { type: "privacy", content: spec.legal_content.privacy_policy },
      { type: "terms", content: spec.legal_content.terms_of_service },
      { type: "cookies", content: spec.legal_content.cookie_policy },
    ];

    for (const p of pages) {
      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO shop_pages (shop_id, page_type, content, generated_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(shopId, p.type, p.content, now, now)
        .run();
    }

    const s = spec.social_stubs;
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO shop_settings (
          shop_id,
          instagram_url, show_instagram,
          facebook_url, show_facebook,
          tiktok_url, show_tiktok,
          twitter_url, show_twitter,
          youtube_url, show_youtube,
          whatsapp_url, show_whatsapp,
          linkedin_url, show_linkedin,
          commission_bearer, product_commission_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        shopId,
        s.instagram_url,
        0,
        s.facebook_url,
        0,
        s.tiktok_url,
        0,
        s.twitter_url,
        0,
        s.youtube_url,
        0,
        s.whatsapp_url,
        0,
        s.linkedin_url,
        0,
        "shop",
        0
      )
      .run();

    await updateGenerationJob(env.DB, jobId, { status: "running", stage: "audit", error: null });
    await putJobKv(env.KV, jobId, { status: "running", stage: "audit", shopSlug });

    const auditMsg: AuditQueueMessage = {
      jobId,
      shopId,
      shopSlug,
      shopName,
    };
    await env.SITE_AUDIT_QUEUE.send(auditMsg);
  } catch (err) {
    const msg = errorMessage(err);
    console.error("[pivot-parlor-builder] Job failed", jobId, err);
    try {
      await updateGenerationJob(env.DB, jobId, { status: "failed", error: msg });
      await putJobKv(env.KV, jobId, { status: "failed", error: msg, shopSlug });
    } catch (persistErr) {
      console.error("[pivot-parlor-builder] Failed to persist failure", persistErr);
    }
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processOneMessage(msg.body, env);
      } catch (err) {
        console.error("[pivot-parlor-builder] Outer failure", err);
      } finally {
        msg.ack();
      }
    }
  },
};
