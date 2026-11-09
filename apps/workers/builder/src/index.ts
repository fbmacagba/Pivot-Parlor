/**
 * pivot-parlor-assembler — Consumes site-assemble-queue: merge KV images+text → shop_sites, complete job, cleanup KV.
 *
 * Every job ends with at most one `site.regenerate.complete` audit entry, in
 * the SAME D1 batch as the writes it records (publish, review or failure).
 */
import type { D1Database, D1PreparedStatement, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";
import { FAILED_JOB_FALLBACK_SQL, finishJob, originActorRef, queueAudit, type AuditRecorder } from "@repo/audit";
import { SchemaOutOfDateError, assertAssemblerSchema } from "./ensure-schema";
import { parseLockedImages } from "./lockedImages";
import {
  buildCandidatePayload,
  CANDIDATE_COLUMNS,
  chooseImage,
  gateCopy,
  mergeCatalog,
  mergeGallery,
  servicesJsonNames,
  siteWriteTarget,
  type CandidateColumnValues,
} from "./publication";

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
  /** Who clicked Regenerate (`subj_user_<id>`). Absent on messages from before the audit trail. */
  origin_actor_ref?: string | null;
}

const WORKER_NAME = "pivot-parlor-assembler";

/** The fixed reason codes a failed completion entry carries (never the error text). */
type FailReason =
  | "missing_text"
  | "invalid_images_kv"
  | "invalid_text_kv"
  | "text_failed_validation"
  | "candidate_store_failed"
  | "schema_out_of_date"
  | "crash";

/** What every completion entry of one job shares. */
interface JobRef {
  jobId: string;
  shopId: string;
  origin: string | null;
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
  // Kept on the parsed message so both wait-path re-sends carry it onward.
  return { jobId: o.jobId, shopId: o.shopId, shopSlug: o.shopSlug, origin_actor_ref: originActorRef(o.origin_actor_ref) };
}

// ── The published row: UPDATE, then INSERT where none exists ─────────────────
// Keyed on shop_id alone and never on a unique index (P14): production may
// list migration 003 as applied by --baseline without its index having run,
// and the old UPDATE-then-INSERT never needed one. In one batch, the UPDATE
// rewrites an existing row and the guarded INSERT creates one only when none
// exists, so exactly one of them writes. Together they write what the old
// pair wrote: every regenerated column plus status on both paths; id and
// template only when the row is created.
const SITE_INSERT_ONLY_COLUMNS = ["id", "shop_id", "template"] as const;
const SITE_PUBLISH_COLUMNS = [...CANDIDATE_COLUMNS, "status"] as const;
const SITE_INSERT_COLUMNS = [...SITE_INSERT_ONLY_COLUMNS, ...SITE_PUBLISH_COLUMNS] as const;
type SiteColumn = (typeof SITE_INSERT_COLUMNS)[number];

const SITE_UPDATE_SQL = `UPDATE shop_sites SET\n  ${SITE_PUBLISH_COLUMNS.map((c) => `${c} = ?`).join(", ")}\nWHERE shop_id = ?`;
const SITE_INSERT_SQL =
  `INSERT INTO shop_sites (${SITE_INSERT_COLUMNS.join(", ")})\n` +
  `SELECT ${SITE_INSERT_COLUMNS.map(() => "?").join(", ")}\n` +
  `WHERE NOT EXISTS (SELECT 1 FROM shop_sites WHERE shop_id = ?)`;

/** The site's two statements, in order: the UPDATE, then the guarded INSERT. */
function siteWrites(db: D1Database, shopId: string, template: string, columns: CandidateColumnValues): D1PreparedStatement[] {
  // One record, bound by column name, so the two column lists cannot drift.
  const values: Record<SiteColumn, string | number | null> = {
    ...columns,
    id: crypto.randomUUID(),
    shop_id: shopId,
    template,
    status: "active",
  };
  return [
    db.prepare(SITE_UPDATE_SQL).bind(...SITE_PUBLISH_COLUMNS.map((c) => values[c]), shopId),
    db.prepare(SITE_INSERT_SQL).bind(...SITE_INSERT_COLUMNS.map((c) => values[c]), shopId),
  ];
}

/** What the activation changes on the shop, read just before the batch; null when nothing. */
function activationChanges(
  before: { status: string | null; is_active: number | null } | null
): Record<string, [unknown, unknown]> | null {
  if (!before) return null;
  const changes: Record<string, [unknown, unknown]> = {};
  if (before.status !== "active") changes.status = [before.status, "active"];
  if (before.is_active !== 1) changes.is_active = [before.is_active, 1];
  return Object.keys(changes).length > 0 ? changes : null;
}

/** Drop the job's working keys once it has finished (complete or failed). */
async function deleteJobKeys(env: Env, jobId: string): Promise<void> {
  await env.KV.delete(genResearchKey(jobId));
  await env.KV.delete(genImagesKey(jobId));
  await env.KV.delete(genTextKey(jobId));
  await env.KV.delete(genAssembleRetriesKey(jobId));
  await env.KV.delete(genAssembleTextRetriesKey(jobId));
}

/** A crash in processOne used to be logged and acked, leaving the job
 *  "running" until the browser poller gave up. Record it as failed, with its
 *  completion entry; a job that already finished is left as it is. Never throws. */
export async function failJobAfterCrash(env: Pick<Env, "DB">, body: unknown, e: unknown): Promise<void> {
  const raw = (body ?? {}) as { jobId?: unknown; shopId?: unknown; origin_actor_ref?: unknown };
  const jobId = raw.jobId;
  if (typeof jobId !== "string" || !jobId) return;
  const error = `assemble: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  const shopId = raw.shopId;
  if (typeof shopId !== "string" || !shopId) {
    // No shop to attach an entry to: the job must still end.
    console.error("[audit] job failed without its completion entry", jobId);
    await fallbackFailedWrite(env.DB, jobId, error);
    return;
  }
  await failJob(
    env.DB,
    queueAudit(env.DB, WORKER_NAME, jobId),
    { jobId, shopId, origin: originActorRef(raw.origin_actor_ref) },
    error,
    "crash"
  );
}

/**
 * End a job as failed with at most one completion entry. `error` goes to
 * generation_jobs only; the entry carries the fixed `reason`. Never throws:
 * if the terminal batch cannot be written, fall back to the plain guarded
 * failed write (the job must still end) and say so in the log (Ruling 5).
 */
async function failJob(db: D1Database, rec: AuditRecorder, job: JobRef, error: string, reason: FailReason): Promise<void> {
  try {
    await finishJob(db, rec, { ...job, status: "failed", stage: "assemble", error, reason });
  } catch (auditErr) {
    console.error("[audit] job failed without its completion entry", job.jobId, auditErr);
    await fallbackFailedWrite(db, job.jobId, error);
  }
}

async function fallbackFailedWrite(db: D1Database, jobId: string, error: string): Promise<void> {
  try {
    await db.prepare(FAILED_JOB_FALLBACK_SQL).bind("assemble", error, new Date().toISOString(), jobId).run();
  } catch (persistErr) {
    console.error(`[${jobId}] [pivot-parlor-assembler] could not record the failure`, persistErr);
  }
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

async function processOne(body: unknown, env: Env): Promise<void> {
  const msg = parseStageMessage(body);
  if (!msg) {
    console.error("[pivot-parlor-assembler] invalid message", body);
    return;
  }

  const { jobId, shopId, shopSlug } = msg;
  const job: JobRef = { jobId, shopId, origin: msg.origin_actor_ref ?? null };
  const rec = queueAudit(env.DB, WORKER_NAME, jobId);

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
      await failJob(env.DB, rec, job, err, "missing_text");
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
      await failJob(env.DB, rec, job, "invalid images KV JSON", "invalid_images_kv");
      return;
    }
  }

  let text: TextKvPayload;
  try {
    text = JSON.parse(textRaw) as TextKvPayload;
  } catch (e) {
    console.error(`[${jobId}] [pivot-parlor-assembler] parse KV failed`, e);
    await failJob(env.DB, rec, job, "invalid KV JSON", "invalid_text_kv");
    return;
  }

  // A menu may legitimately be empty (a shop with no services yet); the text
  // worker builds it from the real services, so only the shape is checked.
  if (!text.headline?.trim() || !Array.isArray(text.services)) {
    const err = "assemble: text failed validation";
    console.error(`[${jobId}] [pivot-parlor-assembler] ${err}`);
    await failJob(env.DB, rec, job, err, "text_failed_validation");
    return;
  }

  // WS-8: the migrations own the schema. A database that missed one fails the
  // job, named; a read that fails propagates to the crash path instead.
  try {
    await assertAssemblerSchema(env.DB);
  } catch (err) {
    if (!(err instanceof SchemaOutOfDateError)) throw err;
    console.error(`[${jobId}] [pivot-parlor-assembler] ${err.message}`);
    await failJob(env.DB, rec, job, err.message, "schema_out_of_date");
    return;
  }

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
    "SELECT website_status, hero_image_url, logo_url, locked_images_json, catalog_images_json, gallery_images_json, services_json FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1"
  )
    .bind(shopId)
    .first<{
      website_status: string | null;
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

  // The regenerated shop_sites values: the review path stores them as the
  // candidate, the publish path writes them to the live row.
  const columns: CandidateColumnValues = {
    headline: text.headline,
    tagline: text.tagline,
    about: text.about,
    services_json,
    hero_image_url,
    logo_url,
    catalog_images_json,
    color_primary: text.color_primary,
    color_accent: text.color_accent,
    font_heading,
    font_body,
    seo_title: text.seo_title,
    seo_description: text.seo_description,
    trust_signals_json: intent.trust_signals_json,
    usps_json: intent.usps_json,
    layout_mood: intent.layout_mood,
    brand_voice: intent.brand_voice,
    hero_cta: intent.hero_cta,
    about_title: intent.about_title,
    palette_json: intent.palette_json,
    heading_weight: intent.heading_weight,
    heading_style: intent.heading_style,
    design_spec: design_spec_json,
    design_version,
    gallery_images_json,
    generated_at: now,
  };

  // ── Owner review (migration 049) ───────────────────────────────────────────
  // A site the public can already reach is never replaced unapproved: the
  // result is stored as the shop's one pending version (a newer regeneration
  // replaces an older pending one) and the live row is left untouched.
  if (siteWriteTarget(existingRow) === "candidate") {
    const payload = buildCandidatePayload({
      columns,
      ownerPalette: ownerColorPrimary && ownerColorAccent ? { primary: ownerColorPrimary, accent: ownerColorAccent } : null,
      serviceNames: text.services.map((s) => s.name),
    });
    const storeCandidate = env.DB.prepare(
      `INSERT INTO shop_site_candidates (shop_id, job_id, payload_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(shop_id) DO UPDATE SET job_id = excluded.job_id, payload_json = excluded.payload_json, created_at = excluded.created_at`
    ).bind(shopId, jobId, payload, now);
    // ONE batch: the candidate, the guarded job completion and its entry.
    let reviewed: "finished" | "already_finished";
    try {
      reviewed = await finishJob(env.DB, rec, { ...job, status: "complete", stage: "review", error: null, reason: null }, [
        storeCandidate,
      ]);
    } catch (e) {
      // The batch rolled back whole, so the deterministic entry id is free again.
      // The error can come from any statement in it, so only a missing
      // candidate table is blamed on migration 049.
      const detail = e instanceof Error ? e.message : String(e);
      const err = /no such table:?\s*shop_site_candidates/i.test(detail)
        ? "assemble: shop_site_candidates is missing (migration 049 has not run); the live site was left unchanged"
        : `assemble: could not store the new version for review; the live site was left unchanged: ${detail}`.slice(0, 500);
      console.error(`[${jobId}] [pivot-parlor-assembler] ${err}`);
      await failJob(env.DB, rec, job, err, "candidate_store_failed");
      await deleteJobKeys(env, jobId);
      return;
    }
    await deleteJobKeys(env, jobId);
    if (reviewed === "already_finished") {
      console.log(`[${jobId}] [pivot-parlor-assembler] another delivery already finished this job; nothing written`);
      return;
    }
    // No site: cache bust and no shop activation: nothing public changed.
    console.log(
      `[${jobId}] [pivot-parlor-assembler] DONE (waiting for review) shopSlug=${shopSlug} status=${existingRow?.website_status ?? "?"} services=${text.services.length}`
    );
    return;
  }

  // ── Publish: ONE batch ─────────────────────────────────────────────────────
  // The site UPDATE and guarded INSERT, the owner palette (when chosen), the
  // shop activation, the guarded job completion and its entry commit together
  // or not at all.
  const publish: D1PreparedStatement[] = siteWrites(env.DB, shopId, template, columns);
  // Persist an owner-chosen palette to the winning slot. Done as an isolated,
  // override-only write so a normal regeneration never clears an existing
  // owner override (the site write leaves owner_color_* untouched). It must
  // follow BOTH site statements, or a first publish would lose it.
  if (ownerColorPrimary && ownerColorAccent) {
    publish.push(
      env.DB.prepare("UPDATE shop_sites SET owner_color_primary = ?, owner_color_accent = ? WHERE shop_id = ?").bind(
        ownerColorPrimary,
        ownerColorAccent,
        shopId
      )
    );
  }
  publish.push(env.DB.prepare("UPDATE shops SET status = 'active', is_active = 1 WHERE id = ?").bind(shopId));

  // Read just before the batch: only the pipeline writes these two fields.
  const shopBefore = await env.DB.prepare("SELECT status, is_active FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ status: string | null; is_active: number | null }>();
  // A throw here reaches the queue handler, which fails the job via failJobAfterCrash.
  const finished = await finishJob(
    env.DB,
    rec,
    { ...job, status: "complete", stage: "complete", error: null, reason: null, changes: activationChanges(shopBefore) },
    publish
  );

  // Only after the batch, and harmless if another delivery finished first.
  await deleteJobKeys(env, jobId);

  try {
    await env.KV.delete(`site:${shopSlug}`);
  } catch {
    /* best-effort bust public site cache */
  }

  if (finished === "already_finished") {
    console.log(`[${jobId}] [pivot-parlor-assembler] another delivery already finished this job; nothing written`);
    return;
  }

  console.log(
    `[${jobId}] [pivot-parlor-assembler] published shop_sites shopId=${shopId}${ownerColorPrimary ? " (owner palette)" : ""}`
  );
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
        await failJobAfterCrash(env, m.body, e);
      } finally {
        m.ack();
      }
    }
  },
};
