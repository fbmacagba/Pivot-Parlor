/**
 * pivot-parlor-assembler — Consumes site-assemble-queue: merge KV images+text → shop_sites, complete job, cleanup KV.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";

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
    content?: {
      hero_cta?: string;
      about_title?: string;
      trust_signals?: string[];
      unique_selling_points?: string[];
    };
  };
  template: string;
  /** Owner-chosen palette override (6-digit hex pair) — persisted to the winning owner_color_* slot. */
  owner_color_primary?: string;
  owner_color_accent?: string;
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
}

function cleanString(v: unknown, maxLen = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, maxLen) : null;
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
  return {
    layout_mood: cleanString(spec?.layout_mood, 40),
    brand_voice: cleanString(spec?.brand_voice, 400),
    hero_cta: cleanString(spec?.content?.hero_cta, 60),
    about_title: cleanString(spec?.content?.about_title, 120),
    trust_signals_json: cleanStringArrayJson(spec?.content?.trust_signals),
    usps_json: cleanStringArrayJson(spec?.content?.unique_selling_points),
    palette_json,
  };
}

const KV_TTL_SEC = 3600;
const ASSEMBLE_MAX_RETRIES = 10;
const ASSEMBLE_RETRY_DELAY_SEC = 60;
const genResearchKey = (jobId: string) => `gen:${jobId}:research`;
const genImagesKey = (jobId: string) => `gen:${jobId}:images`;
const genTextKey = (jobId: string) => `gen:${jobId}:text`;
const genAssembleRetriesKey = (jobId: string) => `gen:${jobId}:assemble:retries`;
/** Separate from assemble:retries so image phase always gets up to 10 waits after text is ready. */
const genAssembleTextRetriesKey = (jobId: string) => `gen:${jobId}:assemble:text_retries`;

const emptyImagesPayload = (jobId: string): ImagesKvPayload => ({
  heroUrl: "",
  logoUrl: "",
  catalogUrls: [],
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

  if (!text.headline?.trim() || !Array.isArray(text.services) || text.services.length < 2) {
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
  if (researchRaw) {
    try {
      const r = JSON.parse(researchRaw) as GenResearchKvPayload;
      if (typeof r.template === "string" && r.template) template = r.template;
      if (HEX6.test(r.owner_color_primary ?? "") && HEX6.test(r.owner_color_accent ?? "")) {
        ownerColorPrimary = r.owner_color_primary!;
        ownerColorAccent = r.owner_color_accent!;
      }
      intent = designIntentFrom(r.spec);
    } catch {
      /* keep default */
    }
  }

  const now = new Date().toISOString();
  const services_json = servicesForJson(text.services);
  const catalog_filtered = (images.catalogUrls ?? []).filter((u) => typeof u === "string" && u.length > 0);
  const catalog_images_json = JSON.stringify(catalog_filtered);

  const hero_image_url = images.heroUrl?.trim() || null;
  const logo_url = images.logoUrl?.trim() || null;

  const upd = await env.DB.prepare(
    `UPDATE shop_sites SET
      headline = ?, tagline = ?, about = ?,
      services_json = ?,
      hero_image_url = ?, logo_url = ?, catalog_images_json = ?,
      color_primary = ?, color_accent = ?, font_heading = ?, font_body = ?,
      seo_title = ?, seo_description = ?,
      trust_signals_json = ?, usps_json = ?, layout_mood = ?, brand_voice = ?,
      hero_cta = ?, about_title = ?, palette_json = ?,
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
      text.font_heading,
      text.font_body,
      text.seo_title,
      text.seo_description,
      intent.trust_signals_json,
      intent.usps_json,
      intent.layout_mood,
      intent.brand_voice,
      intent.hero_cta,
      intent.about_title,
      intent.palette_json,
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
        hero_cta, about_title, palette_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        text.font_heading,
        text.font_body,
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
        intent.palette_json
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
