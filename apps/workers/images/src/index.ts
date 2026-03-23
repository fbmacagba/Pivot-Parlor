/**
 * pivot-parlor-images — Consumes site-images-queue: OpenRouter images → R2 → KV gen:{jobId}:images → site-assemble-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue, R2Bucket } from "@cloudflare/workers-types";

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
}

interface ResearchSpecShape {
  image_prompts?: { hero?: string; logo?: string; catalog?: string[] };
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
}

interface ImagesKvPayload {
  heroUrl: string;
  logoUrl: string;
  catalogUrls: string[];
  completedAt: string;
  errors: Array<{ step: string; detail: string }>;
}

const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";
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

async function openRouterGenerateImage(
  apiKey: string,
  model: string,
  prompt: string,
  aspectRatio: string,
  label: string,
  jobId: string
): Promise<{ buffer: ArrayBuffer | null; httpStatus: number; rawBody: string }> {
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

  const message = (data as { choices?: Array<{ message?: unknown }> })?.choices?.[0]?.message;
  const dataUrl = extractDataImageUrlFromMessage(message);
  if (!dataUrl) {
    console.error(`[${jobId}] [pivot-parlor-images] ${label} no image in response`, text.slice(0, 4000));
    return { buffer: null, httpStatus: res.status, rawBody: text };
  }

  const buf = dataImageUrlToArrayBuffer(dataUrl);
  if (!buf || buf.byteLength === 0) {
    return { buffer: null, httpStatus: res.status, rawBody: text };
  }
  return { buffer: buf, httpStatus: res.status, rawBody: text };
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
  return { jobId: o.jobId, shopId: o.shopId, shopSlug: o.shopSlug, image_model, skip_images };
}

async function processOne(body: unknown, env: Env): Promise<void> {
  const msg = parseStageMessage(body);
  if (!msg) {
    console.error("[pivot-parlor-images] invalid message", body);
    return;
  }

  const { jobId, shopSlug, shopId } = msg;
  console.log(
    `[${jobId}] [pivot-parlor-images] message received jobId=${jobId} shopId=${shopId} shopSlug=${shopSlug} image_model=${msg.image_model ?? "(unset, will use KV or default)"} skip_images=${Boolean(msg.skip_images)}`
  );

  if (msg.skip_images) {
    const row = await env.DB.prepare(
      "SELECT hero_image_url, logo_url, catalog_images_json FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1"
    )
      .bind(shopId)
      .first<{
        hero_image_url: string | null;
        logo_url: string | null;
        catalog_images_json: string | null;
      }>();
    let catalogUrls: string[] = [];
    if (row?.catalog_images_json) {
      try {
        const p = JSON.parse(row.catalog_images_json) as unknown;
        if (Array.isArray(p)) catalogUrls = p.filter((x): x is string => typeof x === "string");
      } catch {
        /* ignore */
      }
    }
    const imagesPayload: ImagesKvPayload = {
      heroUrl: row?.hero_image_url?.trim() ?? "",
      logoUrl: row?.logo_url?.trim() ?? "",
      catalogUrls,
      completedAt: new Date().toISOString(),
      errors: [],
    };
    await env.KV.put(genImagesKey(jobId), JSON.stringify(imagesPayload), { expirationTtl: KV_TTL_SEC });
    await env.SITE_ASSEMBLE_QUEUE.send({ jobId: msg.jobId, shopId: msg.shopId, shopSlug: msg.shopSlug });
    console.log(`[${jobId}] [pivot-parlor-images] skip_images: KV + site-assemble-queue`);
    return;
  }

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(`[${jobId}] [pivot-parlor-images] OPENROUTER_API_KEY missing`);
    return;
  }

  const researchRaw = await env.KV.get(genResearchKey(jobId));
  const researchFound = Boolean(researchRaw);
  if (!researchRaw) {
    console.error(`[${jobId}] [pivot-parlor-images] missing KV ${genResearchKey(jobId)}`);
    return;
  }

  let research: GenResearchKvPayload;
  try {
    research = JSON.parse(researchRaw) as GenResearchKvPayload;
  } catch {
    console.error(`[${jobId}] [pivot-parlor-images] invalid research JSON`);
    return;
  }

  const resolvedImageModel =
    msg.image_model?.trim() || research.image_model?.trim() || DEFAULT_IMAGE_MODEL;

  const ip = research.spec?.image_prompts;
  const heroPrompt = typeof ip?.hero === "string" ? ip.hero : "";
  const logoPrompt = typeof ip?.logo === "string" ? ip.logo : "";
  const catalogAll = Array.isArray(ip?.catalog) ? ip.catalog.filter((x): x is string => typeof x === "string") : [];
  const catalogPrompts = catalogAll.slice(0, 3);

  console.log(
    `[${jobId}] [pivot-parlor-images] KV gen:${jobId}:research found=${researchFound} heroPromptLen=${heroPrompt.length} usingModel=${resolvedImageModel}`
  );

  const baseUrl = env.ASSET_BASE_URL || "https://localhost";
  const prefix = `shops/${shopSlug}`;
  const errors: ImagesKvPayload["errors"] = [];

  let heroUrl = "";
  if (heroPrompt.trim()) {
    const r = await openRouterGenerateImage(apiKey, resolvedImageModel, heroPrompt, "16:9", "hero", jobId);
    if (r.buffer) {
      try {
        await uploadPng(env.ASSETS, `${prefix}/hero.png`, r.buffer);
        heroUrl = publicAssetUrl(baseUrl, shopSlug, "hero.png");
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
        await env.ASSETS.put(`${prefix}/logo.png`, buf, { httpMetadata: { contentType: ct } });
        logoUrl = publicAssetUrl(baseUrl, shopSlug, "logo.png");
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
    const r = await openRouterGenerateImage(apiKey, resolvedImageModel, logoPrompt, "1:1", "logo", jobId);
    if (r.buffer) {
      try {
        await uploadPng(env.ASSETS, `${prefix}/logo.png`, r.buffer);
        logoUrl = publicAssetUrl(baseUrl, shopSlug, "logo.png");
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
    const r = await openRouterGenerateImage(apiKey, resolvedImageModel, p, "1:1", `catalog-${i}`, jobId);
    const filename = `catalog-${i}.png`;
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

  if (!heroUrl) {
    console.error(`[${jobId}] [pivot-parlor-images] HERO FAILED — errors:`, JSON.stringify(errors));
  }

  const imagesPayload: ImagesKvPayload = {
    heroUrl,
    logoUrl,
    catalogUrls,
    completedAt: new Date().toISOString(),
    errors,
  };

  try {
    await env.KV.put(genImagesKey(jobId), JSON.stringify(imagesPayload), { expirationTtl: KV_TTL_SEC });
    console.log(
      `[${jobId}] [pivot-parlor-images] KV write gen:${jobId}:images success heroUrl=${heroUrl || "(empty)"} logoUrl=${logoUrl || "(empty)"} catalogUrls=${JSON.stringify(catalogUrls)}`
    );
    await env.SITE_ASSEMBLE_QUEUE.send({ jobId: msg.jobId, shopId: msg.shopId, shopSlug: msg.shopSlug });
    console.log(`[${jobId}] [pivot-parlor-images] enqueued site-assemble-queue (immediately after KV)`);
  } catch (e) {
    console.error(`[${jobId}] [pivot-parlor-images] KV write gen:${jobId}:images FAILED`, e);
    throw e;
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await processOne(m.body, env);
      } catch (e) {
        console.error("[pivot-parlor-images] outer failure", e);
      } finally {
        m.ack();
      }
    }
  },
};
