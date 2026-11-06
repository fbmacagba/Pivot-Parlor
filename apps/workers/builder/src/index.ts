/**
 * pivot-parlor-assembler — Consumes site-assemble-queue: merge KV images+text → shop_sites, complete job, cleanup KV.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";
import { parseLockedImages } from "./lockedImages";
import { chooseImage, gateCopy, mergeCatalog, mergeGallery, servicesJsonNames } from "./publication";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** Self-requeue when images/text KV not ready yet. */
  SITE_ASSEMBLE_QUEUE: Queue;
  ENVIRONMENT: string;
}

export interface StageMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
}

interface ImagesKvPayload {
  heroUrl: string;
  logoUrl: string;
  catalogUrls: string[];
  /** Absent on payloads from an images worker older than migration 048. */
  galleryUrls?: string[];
  completedAt: string;
  errors: unknown[];
}

interface TextServiceOut {
  name: string;
  price_gbp: number;
  duration_minutes: number;
  description: string;
  image_prompt: string;
}

interface TextKvPayload {
  headline: string;
  tagline: string;
  about: string;
  services: TextServiceOut[];
  seo_title: string;
  seo_description: string;
  color_primary: string;
  color_accent: string;
  font_heading: string;
  font_body: string;
  completedAt: string;
}

interface GenResearchKvPayload {
  /** Design intent from the research spec (WS-6) — persisted to shop_sites
   *  so the renderer stops falling back to hardcoded copy. */
  spec: {
    layout_mood?: string;
    brand_voice?: string;
    palette?: {
      primary?: string;
      accent?: string;
      background?: string;
      text?: string;
      muted?: string;
    };
    typography?: {
      heading_weight?: string;
      heading_style?: string;
    };
    content?: {
      headline?: string;
      about_body?: string;
      hero_cta?: string;
      about_title?: string;
      trust_signals?: string[];
      unique_selling_points?: string[];
    };
  };
  shopName?: string;
  /** Owner's notes and records: the only facts generated copy may claim. */
  style_notes?: string;
  business?: unknown;
  fact_signals?: string[];
  template: string;
  /** Owner-chosen palette override (6-digit hex pair) — persisted to the winning owner_color_* slot. */
  owner_color_primary?: string;
  owner_color_accent?: string;
  /** Design Director (v3) composition spec — opaque JSON, persisted as-is. Absent on legacy (v2) payloads. */
  design_spec?: unknown;
}

/** Sanitized design-intent column values extracted from the research spec. */
interface DesignIntent {
  layout_mood: string | null;
  brand_voice: string | null;
  hero_cta: string | null;
  about_title: string | null;
  trust_signals_json: string | null;
  usps_json: string | null;
  palette_json: string | null;
  /** Curated typography (WS-6 item 5, migration 042). */
  heading_weight: string | null;
  heading_style: string | null;
}

function cleanString(v: unknown, maxLen = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, maxLen) : null;
}

// Curated typography (WS-6 item 5). KEEP IN SYNC with CURATED_FONTS in
// packages/utils/src/curatedFonts.ts and the copy in the research worker —
// the web self-hosts exactly these families.
const CURATED_FONT_NAMES = [
  "Playfair Display",
  "Cormorant Garamond",
  "Libre Baskerville",
  "Lora",
  "DM Sans",
  "Jost",
  "Montserrat",
  "Inter",
  "Work Sans",
  "Space Grotesk",
];

/** Map a proposed font onto the curated set (exact match keeps it; anything
 *  else falls to the role default, honouring a serif/sans hint). */
function coerceCuratedFont(name: string, role: "heading" | "body", styleHint: string): string {
  const wanted = (name ?? "").trim().toLowerCase();
  const match = CURATED_FONT_NAMES.find((f) => f.toLowerCase() === wanted);
  if (match) return match;
  const h = styleHint.toLowerCase();
  // "sans-serif".includes("serif") is true — check sans first.
  const serif = !h.includes("sans") && h.includes("serif");
  if (role === "heading") return serif ? "Playfair Display" : "Montserrat";
  return serif ? "Lora" : "DM Sans";
}

/** JSON array of non-empty strings, or null when empty — the audit worker
 *  treats these columns as JSON arrays and warns on empty ones, so an absent
 *  value must be NULL rather than "[]". */
function cleanStringArrayJson(v: unknown, maxItems = 5): string | null {
  if (!Array.isArray(v)) return null;
  const items = v
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().slice(0, 160))
    .slice(0, maxItems);
  return items.length > 0 ? JSON.stringify(items) : null;
}

function designIntentFrom(spec: GenResearchKvPayload["spec"] | undefined): DesignIntent {
  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  let palette_json: string | null = null;
  const p = spec?.palette;
  if (p && typeof p === "object") {
    const entries = Object.entries(p).filter(
      ([, v]) => typeof v === "string" && HEX6.test(v)
    );
    if (entries.length > 0) palette_json = JSON.stringify(Object.fromEntries(entries));
  }
  // heading_weight must be a CSS weight keyword the web's guard accepts
  // ("100".."900"); anything else persists as NULL (renderer default).
  const weightRaw = cleanString(spec?.typography?.heading_weight, 8);
  const heading_weight = weightRaw && /^[1-9]00$/.test(weightRaw) ? weightRaw : null;
  return {
    layout_mood: cleanString(spec?.layout_mood, 40),
    brand_voice: cleanString(spec?.brand_voice, 400),
    hero_cta: cleanString(spec?.content?.hero_cta, 60),
    about_title: cleanString(spec?.content?.about_title, 120),
    trust_signals_json: cleanStringArrayJson(spec?.content?.trust_signals),
    usps_json: cleanStringArrayJson(spec?.content?.unique_selling_points),
    palette_json,
    heading_weight,
    heading_style: cleanString(spec?.typography?.heading_style, 20),
  };
}

const KV_TTL_SEC = 3600;
// 20 × 60s = 20 min max wait for the images KV. Slow image models (e.g.
// openai/gpt-5.4-image-2 at ~2-3 min/image) take ~15 min to produce all five
// images; the previous 10-min ceiling timed out and completed jobs with no
// imagery even though the images finished moments later. Stays under KV_TTL_SEC.
const ASSEMBLE_MAX_RETRIES = 20;
const ASSEMBLE_RETRY_DELAY_SEC = 60;
const genResearchKey = (jobId: string) => `gen:${jobId}:research`;
const genImagesKey = (jobId: string) => `gen:${jobId}:images`;
const genTextKey = (jobId: string) => `gen:${jobId}:text`;
const genAssembleRetriesKey = (jobId: string) => `gen:${jobId}:assemble:retries`;
/** Separate from assemble:retries so image phase always gets up to ASSEMBLE_MAX_RETRIES waits after text is ready. */
const genAssembleTextRetriesKey = (jobId: string) => `gen:${jobId}:assemble:text_retries`;

const emptyImagesPayload = (jobId: string): ImagesKvPayload => ({
  heroUrl: "",
  logoUrl: "",
  catalogUrls: [],
  galleryUrls: [],
  completedAt: new Date().toISOString(),
  errors: [{ step: "assemble_timeout", detail: `no KV images after ${ASSEMBLE_MAX_RETRIES} retries`, jobId }],
});

function parseStageMessage(body: unknown): StageMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string" || typeof o.shopSlug !== "string") return null;
  return { jobId: o.jobId, shopId: o.shopId, shopSlug: o.shopSlug };
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

async function setShopActive(db: D1Database, shopId: string): Promise<void> {
  await db.prepare("UPDATE shops SET status = ?, is_active = 1 WHERE id = ?").bind("active", shopId).run();
}

function servicesForJson(services: TextServiceOut[]): string {
  return JSON.stringify(
    services.map((s) => ({
      name: s.name,
      price_gbp: s.price_gbp,
      duration_minutes: s.duration_minutes,
      description: s.description,
      image_prompt: s.image_prompt,
    }))
  );
}

async function ensureShopSitesSeoColumns(db: D1Database): Promise<void> {
  const tryAdd = async (name: string, ddl: string) => {
    try {
      await db.prepare(`ALTER TABLE shop_sites ADD COLUMN ${name} ${ddl}`).run();
    } catch {
      /* column exists */
    }
  };
  await tryAdd("seo_title", "TEXT");
  await tryAdd("seo_description", "TEXT");
  // Design-intent columns (WS-6). Canonical DDL: migrations 021 + 023 in the
  // main worker; these defensive adds only bridge a builder deploy that lands
  // before the migration has run.
  await tryAdd("trust_signals_json", "TEXT");
  await tryAdd("usps_json", "TEXT");
  await tryAdd("layout_mood", "TEXT");
  await tryAdd("brand_voice", "TEXT");
  await tryAdd("hero_cta", "TEXT");
  await tryAdd("about_title", "TEXT");
  await tryAdd("palette_json", "TEXT");
  await tryAdd("design_version", "INTEGER NOT NULL DEFAULT 1");
  // Curated typography (WS-6 item 5). Canonical DDL: migration 042.
  await tryAdd("heading_weight", "TEXT");
  await tryAdd("heading_style", "TEXT");
}

async function processOne(body: unknown, env: Env): Promise<void> {
  const msg = parseStageMessage(body);
  if (!msg) {
    console.error("[pivot-parlor-assembler] invalid message", body);
    return;
  }

  const { jobId, shopId, shopSlug } = msg;

  const jobRow = await env.DB.prepare("SELECT status FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
  if (jobRow?.status === "complete" || jobRow?.status === "failed") {
    console.log(`[${jobId}] [pivot-parlor-assembler] skip (job already ${jobRow.status})`);
    return;
  }

  const [imagesRaw, textRaw, researchRaw] = await Promise.all([
    env.KV.get(genImagesKey(jobId)),
    env.KV.get(genTextKey(jobId)),
    env.KV.get(genResearchKey(jobId)),
  ]);

  if (!textRaw) {
    const textRetriesRaw = await env.KV.get(genAssembleTextRetriesKey(jobId));
    const textRetries = textRetriesRaw ? parseInt(textRetriesRaw, 10) || 0 : 0;
    if (textRetries >= ASSEMBLE_MAX_RETRIES) {
      const err = `assemble: missing text after ${textRetries} retries`;
      console.error(`[${jobId}] [pivot-parlor-assembler] ${err}`);
      await updateGenerationJob(env.DB, jobId, { status: "failed", stage: "assemble", error: err });
      await env.KV.delete(genResearchKey(jobId));
      await env.KV.delete(genImagesKey(jobId));
      await env.KV.delete(genTextKey(jobId));
      await env.KV.delete(genAssembleRetriesKey(jobId));
      await env.KV.delete(genAssembleTextRetriesKey(jobId));
      return;
    }
    await env.KV.put(genAssembleTextRetriesKey(jobId), String(textRetries + 1), { expirationTtl: KV_TTL_SEC });
    console.log(`Waiting for text, attempt ${textRetries + 1}/${ASSEMBLE_MAX_RETRIES}, jobId: ${jobId}`);
    await env.SITE_ASSEMBLE_QUEUE.send(msg, { delaySeconds: ASSEMBLE_RETRY_DELAY_SEC });
    return;
  }

  let images: ImagesKvPayload;
  let hadImagesKv = false;

  if (!imagesRaw) {
    const retriesRaw = await env.KV.get(genAssembleRetriesKey(jobId));
    const retries = retriesRaw ? parseInt(retriesRaw, 10) || 0 : 0;
    if (retries >= ASSEMBLE_MAX_RETRIES) {
      console.warn("Images timed out after 10 retries — assembling without images");
      images = emptyImagesPayload(jobId);
    } else {
      await env.KV.put(genAssembleRetriesKey(jobId), String(retries + 1), { expirationTtl: KV_TTL_SEC });
      console.log(`Waiting for images, attempt ${retries + 1}/${ASSEMBLE_MAX_RETRIES}, jobId: ${jobId}`);
      await env.SITE_ASSEMBLE_QUEUE.send(msg, { delaySeconds: ASSEMBLE_RETRY_DELAY_SEC });
      return;
    }
  } else {
    hadImagesKv = true;
    try {
      images = JSON.parse(imagesRaw) as ImagesKvPayload;
    } catch (e) {
      console.error(`[${jobId}] [pivot-parlor-assembler] parse images KV failed`, e);
      await updateGenerationJob(env.DB, jobId, { status: "failed", stage: "assemble", error: "invalid images KV JSON" });
      return;
    }
  }

  let text: TextKvPayload;
  try {
    text = JSON.parse(textRaw) as TextKvPayload;
  } catch (e) {
    console.error(`[${jobId}] [pivot-parlor-assembler] parse KV failed`, e);
    await updateGenerationJob(env.DB, jobId, { status: "failed", stage: "assemble", error: "invalid KV JSON" });
    return;
  }

  // A menu may legitimately be empty (a shop with no services yet); the text
  // worker builds it from the real services, so only the shape is checked.
  if (!text.headline?.trim() || !Array.isArray(text.services)) {
    const err = "assemble: text failed validation";
    console.error(`[${jobId}] [pivot-parlor-assembler] ${err}`);
    await updateGenerationJob(env.DB, jobId, { status: "failed", stage: "assemble", error: err });
    return;
  }

  await ensureShopSitesSeoColumns(env.DB);

  let template = "minimal";
  // An owner-chosen palette is a deliberate override, so it must land in the
  // winning owner_color_* slot (the public site reads owner_color || color).
  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  let ownerColorPrimary: string | null = null;
  let ownerColorAccent: string | null = null;
  let intent = designIntentFrom(undefined);
  let rawDesignSpec: unknown;
  let research: GenResearchKvPayload | null = null;
  if (researchRaw) {
    try {
      const r = JSON.parse(researchRaw) as GenResearchKvPayload;
      research = r;
      if (typeof r.template === "string" && r.template) template = r.template;
      if (HEX6.test(r.owner_color_primary ?? "") && HEX6.test(r.owner_color_accent ?? "")) {
        ownerColorPrimary = r.owner_color_primary!;
        ownerColorAccent = r.owner_color_accent!;
      }
      intent = designIntentFrom(r.spec);
      rawDesignSpec = r.design_spec;
    } catch {
      /* keep default */
    }
  }

  // Design Director (v3): present on payloads from the new research worker;
  // absent -> legacy v2 write so mid-deploy jobs stay consistent.
  const design_spec_json =
    rawDesignSpec && typeof rawDesignSpec === "object" && !Array.isArray(rawDesignSpec)
      ? JSON.stringify(rawDesignSpec)
      : null;
  const design_version = design_spec_json ? 3 : 2;

  const now = new Date().toISOString();

  // The published row (if any) is the baseline this candidate must not
  // downgrade: its images fill any slot this job failed to produce, and its
  // locked hero/logo always survive.
  const existingRow = await env.DB.prepare(
    "SELECT hero_image_url, logo_url, locked_images_json, catalog_images_json, gallery_images_json, services_json FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1"
  )
    .bind(shopId)
    .first<{
      hero_image_url: string | null;
      logo_url: string | null;
      locked_images_json: string | null;
      catalog_images_json: string | null;
      gallery_images_json: string | null;
      services_json: string | null;
    }>();
  const urlList = (json: string | null | undefined): string[] => {
    if (!json) return [];
    try {
      const p = JSON.parse(json) as unknown;
      return Array.isArray(p) ? p.map((u) => (typeof u === "string" ? u : "")) : [];
    } catch {
      return [];
    }
  };

  // ── Truthfulness gate ──────────────────────────────────────────────────────
  const ownerFacts = [
    research?.style_notes ?? "",
    JSON.stringify(research?.business ?? {}),
    ...text.services.map((s) => s.name),
  ].join("\n");
  const gated = gateCopy({
    shopName: research?.shopName ?? shopSlug,
    ownerFacts,
    researchHeadline: research?.spec?.content?.headline,
    researchAbout: research?.spec?.content?.about_body,
    factSignals: Array.isArray(research?.fact_signals) ? research!.fact_signals : [],
    copy: {
      headline: text.headline,
      tagline: text.tagline,
      about: text.about,
      seo_title: text.seo_title,
      seo_description: text.seo_description,
      hero_cta: intent.hero_cta,
      about_title: intent.about_title,
      trust_signals: (research?.spec?.content?.trust_signals ?? []).filter((s): s is string => typeof s === "string"),
      usps: (research?.spec?.content?.unique_selling_points ?? []).filter((s): s is string => typeof s === "string"),
      services: text.services.map((s) => ({ name: s.name, description: s.description ?? "" })),
    },
  });
  if (gated.dropped.length > 0) {
    console.warn(
      `[${jobId}] [pivot-parlor-assembler] dropped ${gated.dropped.length} unverifiable claim(s): ${JSON.stringify(gated.dropped).slice(0, 600)}`
    );
  }
  intent = {
    ...intent,
    hero_cta: gated.copy.hero_cta,
    about_title: gated.copy.about_title,
    trust_signals_json: cleanStringArrayJson(gated.copy.trust_signals),
    usps_json: cleanStringArrayJson(gated.copy.usps),
  };
  text.headline = gated.copy.headline;
  text.tagline = gated.copy.tagline;
  text.about = gated.copy.about;
  text.seo_title = gated.copy.seo_title;
  text.seo_description = gated.copy.seo_description;
  text.services = text.services.map((s, i) => ({ ...s, description: gated.copy.services[i]?.description ?? "" }));
  const services_json = servicesForJson(text.services);

  // ── Images: no downgrade ───────────────────────────────────────────────────
  // Positional: one catalog slot per service, in service order. A failed image
  // is an empty-string hole, never compacted away (the site maps catalog[i] to
  // service[i]), and is filled from the published photo only while the service
  // list is unchanged.
  const locked = parseLockedImages(existingRow?.locked_images_json);
  const hero_image_url = chooseImage({ generated: images.heroUrl, existing: existingRow?.hero_image_url, locked: Boolean(locked.hero) });
  const logo_url = chooseImage({ generated: images.logoUrl, existing: existingRow?.logo_url, locked: Boolean(locked.logo) });
  const catalog_images_json = JSON.stringify(
    mergeCatalog({
      generated: (images.catalogUrls ?? []).map((u) => (typeof u === "string" ? u : "")),
      existing: urlList(existingRow?.catalog_images_json),
      serviceNames: text.services.map((s) => s.name),
      existingServiceNames: servicesJsonNames(existingRow?.services_json),
    })
  );
  const gallery = mergeGallery(
    (images.galleryUrls ?? []).map((u) => (typeof u === "string" ? u : "")),
    urlList(existingRow?.gallery_images_json)
  );
  const gallery_images_json = gallery.length > 0 ? JSON.stringify(gallery) : null;
  const imageErrors = Array.isArray(images.errors) ? images.errors.length : 0;
  if (imageErrors > 0) {
    console.warn(
      `[${jobId}] [pivot-parlor-assembler] ${imageErrors} image step(s) failed; kept the published image in each failed slot`
    );
  }

  // Curated typography (WS-6 item 5): the research worker already pins fonts,
  // but text output from older payloads may carry anything — coerce again so
  // shop_sites only ever stores families the web self-hosts.
  const font_heading = coerceCuratedFont(text.font_heading, "heading", intent.heading_style ?? "");
  const font_body = coerceCuratedFont(text.font_body, "body", "");

  const upd = await env.DB.prepare(
    `UPDATE shop_sites SET
      headline = ?, tagline = ?, about = ?,
      services_json = ?,
      hero_image_url = ?, logo_url = ?, catalog_images_json = ?,
      color_primary = ?, color_accent = ?, font_heading = ?, font_body = ?,
      seo_title = ?, seo_description = ?,
      trust_signals_json = ?, usps_json = ?, layout_mood = ?, brand_voice = ?,
      hero_cta = ?, about_title = ?, palette_json = ?,
      heading_weight = ?, heading_style = ?,
      design_spec = ?, design_version = ?,
      gallery_images_json = ?,
      status = 'active', generated_at = ?
    WHERE shop_id = ?`
  )
    .bind(
      text.headline,
      text.tagline,
      text.about,
      services_json,
      hero_image_url,
      logo_url,
      catalog_images_json,
      text.color_primary,
      text.color_accent,
      font_heading,
      font_body,
      text.seo_title,
      text.seo_description,
      intent.trust_signals_json,
      intent.usps_json,
      intent.layout_mood,
      intent.brand_voice,
      intent.hero_cta,
      intent.about_title,
      intent.palette_json,
      intent.heading_weight,
      intent.heading_style,
      design_spec_json,
      design_version,
      gallery_images_json,
      now,
      shopId
    )
    .run();

  const changed = (upd.meta?.changes ?? 0) as number;
  if (changed === 0) {
    const siteId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO shop_sites (
        id, shop_id, template, headline, tagline, about, services_json,
        color_primary, color_accent, font_heading, font_body,
        hero_image_url, logo_url, catalog_images_json, generated_at, status,
        seo_title, seo_description,
        trust_signals_json, usps_json, layout_mood, brand_voice,
        hero_cta, about_title, palette_json, heading_weight, heading_style,
        design_spec, design_version, gallery_images_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        siteId,
        shopId,
        template,
        text.headline,
        text.tagline,
        text.about,
        services_json,
        text.color_primary,
        text.color_accent,
        font_heading,
        font_body,
        hero_image_url,
        logo_url,
        catalog_images_json,
        now,
        text.seo_title,
        text.seo_description,
        intent.trust_signals_json,
        intent.usps_json,
        intent.layout_mood,
        intent.brand_voice,
        intent.hero_cta,
        intent.about_title,
        intent.palette_json,
        intent.heading_weight,
        intent.heading_style,
        design_spec_json,
        design_version,
        gallery_images_json
      )
      .run();
    console.log(`[${jobId}] [pivot-parlor-assembler] INSERT shop_sites id=${siteId} shopId=${shopId}`);
  } else {
    console.log(`[${jobId}] [pivot-parlor-assembler] UPDATE shop_sites rows=${changed} shopId=${shopId}`);
  }

  // Persist an owner-chosen palette to the winning slot. Done as an isolated,
  // override-only write so a normal regeneration never clears an existing
  // owner override (the main write above leaves owner_color_* untouched).
  if (ownerColorPrimary && ownerColorAccent) {
    await env.DB.prepare(
      "UPDATE shop_sites SET owner_color_primary = ?, owner_color_accent = ? WHERE shop_id = ?"
    )
      .bind(ownerColorPrimary, ownerColorAccent, shopId)
      .run();
    console.log(`[${jobId}] [pivot-parlor-assembler] set owner palette override shopId=${shopId}`);
  }

  await updateGenerationJob(env.DB, jobId, {
    status: "complete",
    stage: "complete",
    error: null,
  });
  await setShopActive(env.DB, shopId);

  await env.KV.delete(genResearchKey(jobId));
  await env.KV.delete(genImagesKey(jobId));
  await env.KV.delete(genTextKey(jobId));
  await env.KV.delete(genAssembleRetriesKey(jobId));
  await env.KV.delete(genAssembleTextRetriesKey(jobId));

  try {
    await env.KV.delete(`site:${shopSlug}`);
  } catch {
    /* best-effort bust public site cache */
  }

  if (hadImagesKv) {
    console.log(
      `[${jobId}] [pivot-parlor-assembler] stored heroUrl=${hero_image_url ?? "(null)"} logoUrl=${logo_url ?? "(null)"}`
    );
  }

  console.log(
    `[${jobId}] [pivot-parlor-assembler] DONE shopSlug=${shopSlug} heroUrl=${hero_image_url ? "yes" : "no"} services=${text.services.length}`
  );
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await processOne(m.body, env);
      } catch (e) {
        console.error("[pivot-parlor-assembler] outer failure", e);
      } finally {
        m.ack();
      }
    }
  },
};
