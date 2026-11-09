/**
 * pivot-parlor-images — Consumes site-images-queue: OpenRouter images → R2 → KV gen:{jobId}:images → site-assemble-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue, R2Bucket } from "@cloudflare/workers-types";
import {
  AuditWriteError,
  auditAiCall,
  FAILED_JOB_FALLBACK_SQL,
  finishJob,
  originActorRef,
  queueAudit,
  type AuditRecorder,
} from "@repo/audit";

export interface Env {
  ASSETS: R2Bucket;
  KV: KVNamespace;
  DB: D1Database;
  SITE_ASSEMBLE_QUEUE: Queue;
  OPENROUTER_API_KEY: string;
  ENVIRONMENT: string;
  ASSET_BASE_URL: string;
}

export interface StageMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
  image_model?: string;
  skip_images?: boolean;
  /** Who clicked Regenerate (`subj_user_<id>`). Absent on messages from before the audit trail. */
  origin_actor_ref?: string | null;
}

interface ResearchSpecShape {
  image_prompts?: { hero?: string; logo?: string; catalog?: string[]; gallery?: string[] };
}

interface GenResearchKvPayload {
  spec: ResearchSpecShape;
  services: unknown[];
  jobId: string;
  shopId: string;
  shopSlug: string;
  shopName: string;
  shopType: string;
  hasLogoFile: boolean;
  template: string;
  text_model?: string;
  image_model?: string;
  /** Who clicked Regenerate; research writes it, absent on older payloads. */
  origin_actor_ref?: string | null;
}

interface ImagesKvPayload {
  heroUrl: string;
  logoUrl: string;
  catalogUrls: string[];
  /** "The space" photos; "" marks a failed slot (the assembler keeps the old one). */
  galleryUrls: string[];
  completedAt: string;
  errors: Array<{ step: string; detail: string }>;
}

/** Job-scoped object name. Each run writes NEW keys, so a regeneration can
 *  never change the bytes behind URLs the live site is serving: until the
 *  assembler publishes, the published row keeps pointing at the old objects,
 *  and a failed or rejected job leaves them untouched. (The old fixed names,
 *  hero.png and catalog-<i>.png, were overwritten mid-job.) Flat, because the
 *  public route is /assets/:shopSlug/:filename. */
export function jobAssetName(jobId: string, slot: string): string {
  const tag = jobId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "job";
  return `g${tag}-${slot}.png`;
}

const GALLERY_MAX = 3;

const WORKER_NAME = "pivot-parlor-images";
const AUDIT_REFUSED_ERROR = "Could not record this action; nothing was changed.";

/** A model call that produced no image. Carries the HTTP status (when there was
 *  one) so the audit reason reads "ImageGenerationError (HTTP 500)"; the provider
 *  body stays on `result` and never enters the message. */
export class ImageGenerationError extends Error {
  readonly status?: number;
  readonly result: ImageResult;
  constructor(result: ImageResult) {
    super("image generation failed");
    this.name = "ImageGenerationError";
    if (result.httpStatus > 0) this.status = result.httpStatus;
    this.result = result;
  }
}

const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KV_TTL_SEC = 3600;

const genResearchKey = (jobId: string) => `gen:${jobId}:research`;
const genImagesKey = (jobId: string) => `gen:${jobId}:images`;

function publicAssetUrl(base: string, shopSlug: string, file: string): string {
  const b = base.replace(/\/$/, "");
  return `${b}/assets/${shopSlug}/${file}`;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function dataImageUrlToArrayBuffer(dataUrl: string): ArrayBuffer | null {
  if (!dataUrl.startsWith("data:image/")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1).replace(/\s/g, "");
  if (!payload) return null;
  if (meta.includes(";base64")) {
    try {
      return base64ToArrayBuffer(payload);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeContentParts(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") {
    const t = content.trim();
    if (t.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* ignore */
      }
    }
  }
  return [];
}

function extractDataImageUrlFromMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;

  // OpenRouter image models (Gemini flash-image) return the generated image in
  // the assistant message's `images` array; `content` is usually null/text.
  const images = m.images;
  if (Array.isArray(images)) {
    for (const img of images) {
      if (!img || typeof img !== "object") continue;
      const iu = (img as { image_url?: unknown }).image_url;
      const url = typeof iu === "string" ? iu : (iu as { url?: string } | null)?.url;
      if (typeof url === "string" && url.startsWith("data:image/")) return url;
    }
  }

  const content = m.content;

  const direct = (content as { image_url?: { url?: string } } | null)?.image_url?.url;
  if (typeof direct === "string" && direct.startsWith("data:image/")) return direct;

  const parts = normalizeContentParts(content);
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
      const url = (p.image_url as { url?: string }).url;
      if (typeof url === "string" && url.startsWith("data:image/")) return url;
    }
  }
  return null;
}

interface ImageResult {
  buffer: ArrayBuffer | null;
  httpStatus: number;
  rawBody: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function openRouterGenerateImage(
  apiKey: string,
  model: string,
  prompt: string,
  aspectRatio: string,
  label: string,
  jobId: string
): Promise<ImageResult> {
  const promptPreview = prompt.slice(0, 100);
  console.log(
    `[${jobId}] [pivot-parlor-images] OpenRouter request ${label} model=${model} prompt[0:100]=${JSON.stringify(promptPreview)}`
  );

  const requestBody = {
    model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ],
    modalities: ["image", "text"],
    image_config: { aspect_ratio: aspectRatio },
  };

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://pivotparlor.com",
        "X-Title": "Pivot Parlor Images",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`[${jobId}] [pivot-parlor-images] ${label} network error`, errMsg);
    return { buffer: null, httpStatus: 0, rawBody: errMsg };
  }

  const text = await res.text();
  console.log(
    `[${jobId}] [pivot-parlor-images] OpenRouter response ${label} status=${res.status} body[0:200]=${JSON.stringify(text.slice(0, 200))}`
  );
  if (!res.ok) {
    console.error(`[${jobId}] [pivot-parlor-images] ${label} HTTP ${res.status}`, text.slice(0, 2000));
    return { buffer: null, httpStatus: res.status, rawBody: text };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`[${jobId}] [pivot-parlor-images] ${label} invalid JSON`, text.slice(0, 2000));
    return { buffer: null, httpStatus: res.status, rawBody: text };
  }

  const usage = (data as { usage?: ImageResult["usage"] } | null)?.usage;
  const message = (data as { choices?: Array<{ message?: unknown }> })?.choices?.[0]?.message;
  const dataUrl = extractDataImageUrlFromMessage(message);
  if (!dataUrl) {
    console.error(`[${jobId}] [pivot-parlor-images] ${label} no image in response`, text.slice(0, 4000));
    return { buffer: null, httpStatus: res.status, rawBody: text, usage };
  }

  const buf = dataImageUrlToArrayBuffer(dataUrl);
  if (!buf || buf.byteLength === 0) {
    return { buffer: null, httpStatus: res.status, rawBody: text, usage };
  }
  return { buffer: buf, httpStatus: res.status, rawBody: text, usage };
}

/** One audited model call. Throws ImageGenerationError when no image came back
 *  (recorded as a failed outcome) and AuditWriteError when the trail refuses
 *  the started write (the model is then never called). The R2 upload is the
 *  caller's, outside this call. */
async function auditedImage(
  rec: AuditRecorder,
  audit: { model: string; shopId: string; origin: string | null },
  purpose: string,
  call: () => Promise<ImageResult>
): Promise<ImageResult> {
  return auditAiCall(
    rec,
    { purpose, model: audit.model, shopId: audit.shopId, origin: audit.origin },
    async () => {
      const r = await call();
      if (!r.buffer) throw new ImageGenerationError(r);
      return r;
    },
    (r) => ({
      model: audit.model,
      route: "openrouter",
      inputTokens: r.usage?.prompt_tokens ?? null,
      outputTokens: r.usage?.completion_tokens ?? null,
      costUsd: null,
      costBasis: null,
    })
  );
}

async function uploadPng(bucket: R2Bucket, key: string, buf: ArrayBuffer): Promise<void> {
  await bucket.put(key, buf, { httpMetadata: { contentType: "image/png" } });
}

function parseStageMessage(body: unknown): StageMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string" || typeof o.shopSlug !== "string") return null;
  const image_model =
    typeof o.image_model === "string" && o.image_model.trim() ? o.image_model.trim() : undefined;
  const skip_images = o.skip_images === true;
  return {
    jobId: o.jobId,
    shopId: o.shopId,
    shopSlug: o.shopSlug,
    image_model,
    skip_images,
    origin_actor_ref: originActorRef(o.origin_actor_ref),
  };
}

async function processOne(body: unknown, env: Env): Promise<void> {
  const msg = parseStageMessage(body);
  if (!msg) {
    console.error("[pivot-parlor-images] invalid message", body);
    return;
  }

  const { jobId, shopSlug, shopId } = msg;
  const rec = queueAudit(env.DB, WORKER_NAME, jobId);
  // The message's origin wins; the research payload's fills in for older messages.
  let origin: string | null = msg.origin_actor_ref ?? null;
  console.log(
    `[${jobId}] [pivot-parlor-images] message received jobId=${jobId} shopId=${shopId} shopSlug=${shopSlug} image_model=${msg.image_model ?? "(unset, will use KV or default)"} skip_images=${Boolean(msg.skip_images)}`
  );

  if (msg.skip_images) {
    const row = await env.DB.prepare(
      "SELECT hero_image_url, logo_url, catalog_images_json, gallery_images_json FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1"
    )
      .bind(shopId)
      .first<{
        hero_image_url: string | null;
        logo_url: string | null;
        catalog_images_json: string | null;
        gallery_images_json: string | null;
      }>();
    const urls = (json: string | null | undefined): string[] => {
      if (!json) return [];
      try {
        const p = JSON.parse(json) as unknown;
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    };
    const imagesPayload: ImagesKvPayload = {
      heroUrl: row?.hero_image_url?.trim() ?? "",
      logoUrl: row?.logo_url?.trim() ?? "",
      catalogUrls: urls(row?.catalog_images_json),
      galleryUrls: urls(row?.gallery_images_json),
      completedAt: new Date().toISOString(),
      errors: [],
    };
    await env.KV.put(genImagesKey(jobId), JSON.stringify(imagesPayload), { expirationTtl: KV_TTL_SEC });
    await env.SITE_ASSEMBLE_QUEUE.send({
      jobId: msg.jobId,
      shopId: msg.shopId,
      shopSlug: msg.shopSlug,
      origin_actor_ref: origin,
    });
    console.log(`[${jobId}] [pivot-parlor-images] skip_images: KV + site-assemble-queue`);
    return;
  }

  // A configuration or hand-off failure still hands the assembler an explicit
  // "no new images" payload, so the job finishes now (keeping every existing
  // image) instead of after a 20-minute wait for KV that will never appear.
  const handOffWithoutImages = async (step: string, detail: string) => {
    console.error(`[${jobId}] [pivot-parlor-images] ${step}: ${detail}`);
    const empty: ImagesKvPayload = {
      heroUrl: "",
      logoUrl: "",
      catalogUrls: [],
      galleryUrls: [],
      completedAt: new Date().toISOString(),
      errors: [{ step, detail }],
    };
    await env.KV.put(genImagesKey(jobId), JSON.stringify(empty), { expirationTtl: KV_TTL_SEC });
    await env.SITE_ASSEMBLE_QUEUE.send({
      jobId: msg.jobId,
      shopId: msg.shopId,
      shopSlug: msg.shopSlug,
      origin_actor_ref: origin,
    });
  };

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    await handOffWithoutImages("config", "OPENROUTER_API_KEY missing");
    return;
  }

  const researchRaw = await env.KV.get(genResearchKey(jobId));
  const researchFound = Boolean(researchRaw);
  if (!researchRaw) {
    await handOffWithoutImages("research_kv", `missing KV ${genResearchKey(jobId)}`);
    return;
  }

  let research: GenResearchKvPayload;
  try {
    research = JSON.parse(researchRaw) as GenResearchKvPayload;
  } catch {
    await handOffWithoutImages("research_kv", "invalid research JSON");
    return;
  }

  origin = origin ?? originActorRef(research.origin_actor_ref);
  const audit = (model: string) => ({ model, shopId, origin });

  const resolvedImageModel =
    msg.image_model?.trim() || research.image_model?.trim() || DEFAULT_IMAGE_MODEL;

  const ip = research.spec?.image_prompts;
  const heroPrompt = typeof ip?.hero === "string" ? ip.hero : "";
  const logoPrompt = typeof ip?.logo === "string" ? ip.logo : "";
  const catalogAll = Array.isArray(ip?.catalog) ? ip.catalog.filter((x): x is string => typeof x === "string") : [];
  // One catalog image per service: research emits exactly services.length prompts.
  // Generation is sequential (~15-20s/image on the fast default model), so a
  // generous ceiling keeps a pathological service count inside the queue-consumer
  // budget. It TRUNCATES rather than fails, and logs so a truncation is visible;
  // truncated services render imageless (positional mapping on the site).
  const CATALOG_MAX = 15;
  const catalogPrompts = catalogAll.slice(0, CATALOG_MAX);
  if (catalogAll.length > CATALOG_MAX) {
    console.warn(
      `[${jobId}] [pivot-parlor-images] catalog prompts ${catalogAll.length} exceed ceiling ${CATALOG_MAX}; generating first ${CATALOG_MAX}, remaining services render imageless`
    );
  }

  console.log(
    `[${jobId}] [pivot-parlor-images] KV gen:${jobId}:research found=${researchFound} heroPromptLen=${heroPrompt.length} usingModel=${resolvedImageModel}`
  );

  const baseUrl = env.ASSET_BASE_URL || "https://localhost";
  const prefix = `shops/${shopSlug}`;
  const errors: ImagesKvPayload["errors"] = [];

  // One audited model call per image. A missing image is not a failed job: the
  // ImageGenerationError is turned back into today's result so the caller records
  // its `errors` entry. Anything else (AuditWriteError included) propagates.
  const generate = async (purpose: string, prompt: string, aspect: string, label: string): Promise<ImageResult> => {
    try {
      return await auditedImage(rec, audit(resolvedImageModel), purpose, () =>
        openRouterGenerateImage(apiKey, resolvedImageModel, prompt, aspect, label, jobId)
      );
    } catch (e) {
      if (e instanceof ImageGenerationError) return e.result;
      throw e;
    }
  };

  let heroUrl = "";
  if (heroPrompt.trim()) {
    const r = await generate("site_image_hero", heroPrompt, "16:9", "hero");
    if (r.buffer) {
      try {
        const name = jobAssetName(jobId, "hero");
        await uploadPng(env.ASSETS, `${prefix}/${name}`, r.buffer);
        heroUrl = publicAssetUrl(baseUrl, shopSlug, name);
        console.log(`[${jobId}] [pivot-parlor-images] hero uploaded ${heroUrl}`);
      } catch (e) {
        const d = e instanceof Error ? e.message : String(e);
        errors.push({ step: "hero_r2", detail: d });
        console.error(`[${jobId}] [pivot-parlor-images] hero R2 failed`, d);
      }
    } else {
      errors.push({ step: "hero_openrouter", detail: r.rawBody.slice(0, 8000) });
    }
  } else {
    errors.push({ step: "hero_prompt", detail: "empty hero prompt" });
  }

  let logoUrl = "";
  if (research.hasLogoFile) {
    const uploaded = await env.ASSETS.get(`${prefix}/logo-upload`);
    if (uploaded?.body) {
      try {
        const buf = await uploaded.arrayBuffer();
        const ct = uploaded.httpMetadata?.contentType ?? "image/png";
        const name = jobAssetName(jobId, "logo");
        await env.ASSETS.put(`${prefix}/${name}`, buf, { httpMetadata: { contentType: ct } });
        logoUrl = publicAssetUrl(baseUrl, shopSlug, name);
        console.log(`[${jobId}] [pivot-parlor-images] logo from upload ${logoUrl}`);
      } catch (e) {
        const d = e instanceof Error ? e.message : String(e);
        errors.push({ step: "logo_copy", detail: d });
      }
    } else {
      console.log(`[${jobId}] [pivot-parlor-images] hasLogoFile but no logo-upload object`);
    }
  }

  if (!logoUrl && logoPrompt.trim()) {
    const r = await generate("site_image_logo", logoPrompt, "1:1", "logo");
    if (r.buffer) {
      try {
        const name = jobAssetName(jobId, "logo");
        await uploadPng(env.ASSETS, `${prefix}/${name}`, r.buffer);
        logoUrl = publicAssetUrl(baseUrl, shopSlug, name);
        console.log(`[${jobId}] [pivot-parlor-images] logo generated ${logoUrl}`);
      } catch (e) {
        const d = e instanceof Error ? e.message : String(e);
        errors.push({ step: "logo_r2", detail: d });
      }
    } else {
      errors.push({ step: "logo_openrouter", detail: r.rawBody.slice(0, 8000) });
    }
  }

  const catalogUrls: string[] = [];
  for (let i = 0; i < catalogPrompts.length; i++) {
    const p = catalogPrompts[i]!;
    const r = await generate(`site_image_catalog_${i}`, p, "1:1", `catalog-${i}`);
    const filename = jobAssetName(jobId, `catalog-${i}`);
    if (r.buffer) {
      try {
        await uploadPng(env.ASSETS, `${prefix}/${filename}`, r.buffer);
        catalogUrls.push(publicAssetUrl(baseUrl, shopSlug, filename));
        console.log(`[${jobId}] [pivot-parlor-images] ${filename} ok`);
      } catch (e) {
        const d = e instanceof Error ? e.message : String(e);
        errors.push({ step: `catalog_${i}_r2`, detail: d });
        catalogUrls.push("");
      }
    } else {
      errors.push({ step: `catalog_${i}_openrouter`, detail: r.rawBody.slice(0, 8000) });
      catalogUrls.push("");
    }
  }

  // "The space": interior / tools / detail photos for the gallery section.
  // Positional like the catalog: a failed slot is "" so the assembler can keep
  // that slot's previously published photo.
  const galleryPrompts = (Array.isArray(ip?.gallery) ? ip.gallery : [])
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .slice(0, GALLERY_MAX);
  const galleryUrls: string[] = [];
  for (let i = 0; i < galleryPrompts.length; i++) {
    const r = await generate(`site_image_gallery_${i}`, galleryPrompts[i]!, "4:3", `gallery-${i}`);
    const filename = jobAssetName(jobId, `gallery-${i}`);
    if (r.buffer) {
      try {
        await uploadPng(env.ASSETS, `${prefix}/${filename}`, r.buffer);
        galleryUrls.push(publicAssetUrl(baseUrl, shopSlug, filename));
      } catch (e) {
        errors.push({ step: `gallery_${i}_r2`, detail: e instanceof Error ? e.message : String(e) });
        galleryUrls.push("");
      }
    } else {
      errors.push({ step: `gallery_${i}_openrouter`, detail: r.rawBody.slice(0, 8000) });
      galleryUrls.push("");
    }
  }

  if (!heroUrl) {
    console.error(`[${jobId}] [pivot-parlor-images] HERO FAILED, errors:`, JSON.stringify(errors));
  }

  const imagesPayload: ImagesKvPayload = {
    heroUrl,
    logoUrl,
    catalogUrls,
    galleryUrls,
    completedAt: new Date().toISOString(),
    errors,
  };

  try {
    await env.KV.put(genImagesKey(jobId), JSON.stringify(imagesPayload), { expirationTtl: KV_TTL_SEC });
    console.log(
      `[${jobId}] [pivot-parlor-images] KV write gen:${jobId}:images success heroUrl=${heroUrl || "(empty)"} logoUrl=${logoUrl || "(empty)"} catalogUrls=${JSON.stringify(catalogUrls)}`
    );
    await env.SITE_ASSEMBLE_QUEUE.send({
      jobId: msg.jobId,
      shopId: msg.shopId,
      shopSlug: msg.shopSlug,
      origin_actor_ref: origin,
    });
    console.log(`[${jobId}] [pivot-parlor-images] enqueued site-assemble-queue (immediately after KV)`);
  } catch (e) {
    console.error(`[${jobId}] [pivot-parlor-images] KV write gen:${jobId}:images FAILED`, e);
    throw e;
  }
}

/**
 * An unexpected error still hands the assembler an explicit "no new images"
 * payload, the same degrade path as a missing key: the job finishes now and
 * keeps every published image, instead of the assembler polling 20 times,
 * 60 s apart, for a KV entry that will never appear. Images never fail a job
 * over a model or storage problem. The one exception is a refused audit write:
 * publishing a site with no photos because the trail was down is wrong, so that
 * ends the job as failed and assembles nothing.
 */
export async function handOffAfterCrash(
  env: Pick<Env, "KV" | "SITE_ASSEMBLE_QUEUE" | "DB">,
  body: unknown,
  e: unknown
): Promise<void> {
  const b = (body ?? {}) as { jobId?: unknown; shopId?: unknown; shopSlug?: unknown; origin_actor_ref?: unknown };
  if (typeof b.jobId !== "string" || typeof b.shopId !== "string" || typeof b.shopSlug !== "string") return;
  const origin = originActorRef(b.origin_actor_ref);
  if (e instanceof AuditWriteError) {
    await failJob(env.DB, { jobId: b.jobId, shopId: b.shopId, origin });
    return;
  }
  const empty: ImagesKvPayload = {
    heroUrl: "",
    logoUrl: "",
    catalogUrls: [],
    galleryUrls: [],
    completedAt: new Date().toISOString(),
    errors: [{ step: "crash", detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) }],
  };
  try {
    await env.KV.put(genImagesKey(b.jobId), JSON.stringify(empty), { expirationTtl: KV_TTL_SEC });
    await env.SITE_ASSEMBLE_QUEUE.send({
      jobId: b.jobId,
      shopId: b.shopId,
      shopSlug: b.shopSlug,
      origin_actor_ref: origin,
    });
  } catch (handOffErr) {
    console.error(`[${b.jobId}] [pivot-parlor-images] could not hand off after a crash`, handOffErr);
  }
}

/**
 * End a job as failed with at most one completion entry. Never throws: if the
 * entry cannot be written, fall back to the plain guarded failed write (the job
 * must still end) and say so in the log.
 */
async function failJob(
  db: D1Database,
  job: { jobId: string; shopId: string; origin: string | null }
): Promise<void> {
  try {
    await finishJob(db, queueAudit(db, WORKER_NAME, job.jobId), {
      ...job,
      status: "failed",
      stage: "images",
      error: AUDIT_REFUSED_ERROR,
      reason: "audit_refused",
    });
  } catch (auditErr) {
    console.error("[audit] job failed without its completion entry", job.jobId, auditErr);
    try {
      await db
        .prepare(FAILED_JOB_FALLBACK_SQL)
        .bind("images", AUDIT_REFUSED_ERROR, new Date().toISOString(), job.jobId)
        .run();
    } catch (persistErr) {
      console.error(`[${job.jobId}] [pivot-parlor-images] could not record the failure`, persistErr);
    }
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await processOne(m.body, env);
      } catch (e) {
        console.error("[pivot-parlor-images] outer failure", e);
        await handOffAfterCrash(env, m.body, e);
      } finally {
        m.ack();
      }
    }
  },
};
