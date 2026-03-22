/**
 * pivot-parlor-images — Consumes site-build-queue: OpenRouter image gen → R2 → site-assemble-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: R2Bucket;
  SITE_ASSEMBLE_QUEUE: Queue;
  OPENROUTER_API_KEY: string;
  ENVIRONMENT: string;
  ASSET_BASE_URL: string;
}

const IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ImagePrompts {
  hero: string;
  logo: string;
  catalog: string[];
}

/** Message from site-build-queue (nested spec and/or flat research output). */
export interface BuildQueueMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
  shopName: string;
  shopType: string;
  hasLogoFile: boolean;
  researchOutput: Record<string, unknown>;
  researchSpecification?: Record<string, unknown>;
  template?: string;
  design_notes?: string;
}

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

function jobKvKey(jobId: string): string {
  return `job:${jobId}`;
}

async function putJobKv(kv: KVNamespace, jobId: string, data: Record<string, unknown>): Promise<void> {
  await kv.put(jobKvKey(jobId), JSON.stringify(data));
}

async function updateGenerationJob(
  db: D1Database,
  id: string,
  patch: {
    status?: string;
    stage?: string;
    build_output?: string | null;
    error?: string | null;
  }
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
  if (patch.build_output !== undefined) {
    sets.push("build_output = ?");
    vals.push(patch.build_output);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  vals.push(id);
  await db.prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

/** User-requested helper: raw base64 string → ArrayBuffer (no data: prefix). */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
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

/**
 * OpenRouter multimodal: choices[0].message.content[] with image_url.url data URLs.
 * Also tolerates nested content[0].image_url.url per provider quirks.
 */
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

async function openRouterGenerateImageBuffer(
  apiKey: string,
  prompt: string,
  aspectRatio: string
): Promise<ArrayBuffer | null> {
  const requestBody = {
    model: IMAGE_MODEL,
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
    console.error("[pivot-parlor-images] OpenRouter fetch failed", e);
    return null;
  }

  const text = await res.text();
  if (!res.ok) {
    console.error("[pivot-parlor-images] OpenRouter error", res.status, text.slice(0, 800));
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("[pivot-parlor-images] OpenRouter response not JSON");
    return null;
  }

  const message = (data as { choices?: Array<{ message?: unknown }> })?.choices?.[0]?.message;
  const dataUrl = extractDataImageUrlFromMessage(message);
  if (!dataUrl) {
    console.error("[pivot-parlor-images] No data:image URL in OpenRouter message");
    return null;
  }

  const buf = dataImageUrlToArrayBuffer(dataUrl);
  if (!buf || buf.byteLength === 0) {
    console.error("[pivot-parlor-images] Failed to decode image data URL");
    return null;
  }
  return buf;
}

function resolveImagePrompts(msg: BuildQueueMessage): ImagePrompts {
  const ro = msg.researchOutput;
  const nested = ro.image_prompts as Record<string, unknown> | undefined;
  if (
    nested &&
    typeof nested.hero === "string" &&
    typeof nested.logo === "string" &&
    Array.isArray(nested.catalog)
  ) {
    return {
      hero: nested.hero,
      logo: nested.logo,
      catalog: nested.catalog.filter((x): x is string => typeof x === "string"),
    };
  }

  const rs = msg.researchSpecification;
  const rsImg = rs?.image_prompts as Record<string, unknown> | undefined;
  if (
    rsImg &&
    typeof rsImg.hero === "string" &&
    typeof rsImg.logo === "string" &&
    Array.isArray(rsImg.catalog)
  ) {
    return {
      hero: rsImg.hero,
      logo: rsImg.logo,
      catalog: rsImg.catalog.filter((x): x is string => typeof x === "string"),
    };
  }

  const hero = typeof ro.hero_image_prompt === "string" ? ro.hero_image_prompt : "";
  const logo = typeof ro.logo_prompt === "string" ? ro.logo_prompt : "";
  const services = Array.isArray(ro.services) ? ro.services : [];
  const catalog = services.map((s) => {
    if (s && typeof s === "object" && typeof (s as { image_prompt?: string }).image_prompt === "string") {
      return (s as { image_prompt: string }).image_prompt;
    }
    return "";
  });
  return { hero, logo, catalog };
}

function mergeResearchOutputForDownstream(msg: BuildQueueMessage, prompts: ImagePrompts): Record<string, unknown> {
  return {
    ...msg.researchOutput,
    image_prompts: prompts,
  };
}

function parseInput(body: unknown): BuildQueueMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string" || typeof o.shopSlug !== "string") return null;
  if (typeof o.shopName !== "string" || typeof o.shopType !== "string") return null;
  if (typeof o.hasLogoFile !== "boolean") return null;
  if (!o.researchOutput || typeof o.researchOutput !== "object") return null;
  const msg: BuildQueueMessage = {
    jobId: o.jobId,
    shopId: o.shopId,
    shopSlug: o.shopSlug,
    shopName: o.shopName,
    shopType: o.shopType,
    hasLogoFile: o.hasLogoFile,
    researchOutput: o.researchOutput as Record<string, unknown>,
  };
  if (o.researchSpecification && typeof o.researchSpecification === "object") {
    msg.researchSpecification = o.researchSpecification as Record<string, unknown>;
  }
  if (typeof o.template === "string") msg.template = o.template;
  if (typeof o.design_notes === "string") msg.design_notes = o.design_notes;
  return msg;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function uploadPng(env: Env, key: string, buffer: ArrayBuffer): Promise<void> {
  await env.ASSETS.put(key, buffer, {
    httpMetadata: { contentType: "image/png" },
  });
}

function publicAssetUrl(env: Env, shopSlug: string, filename: string): string {
  const base = (env.ASSET_BASE_URL ?? "https://api.pivotparlor.com").replace(/\/$/, "");
  return `${base}/assets/${shopSlug}/${filename}`;
}

async function processOneMessage(body: unknown, env: Env): Promise<void> {
  const input = parseInput(body);
  if (!input) {
    console.error("[pivot-parlor-images] Invalid queue message", body);
    return;
  }

  const { jobId, shopSlug, hasLogoFile } = input;
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const msg = "OPENROUTER_API_KEY is not configured";
    try {
      await updateGenerationJob(env.DB, jobId, { status: "failed", error: msg });
      await putJobKv(env.KV, jobId, { status: "failed", error: msg, shopSlug });
    } catch (e) {
      console.error("[pivot-parlor-images] Failed to persist config error", e);
    }
    return;
  }

  try {
    const prompts = resolveImagePrompts(input);
    const prefix = `shops/${shopSlug}`;

    const heroTask = (async (): Promise<string> => {
      const p = prompts.hero?.trim();
      if (!p) return "";
      const settled = await Promise.allSettled([openRouterGenerateImageBuffer(apiKey, p, "16:9")]);
      const buf = settled[0].status === "fulfilled" ? settled[0].value : null;
      if (!buf) return "";
      try {
        await uploadPng(env, `${prefix}/hero.png`, buf);
        return publicAssetUrl(env, shopSlug, "hero.png");
      } catch (e) {
        console.error("[pivot-parlor-images] Hero R2 upload failed", e);
        return "";
      }
    })();

    const logoTask = (async (): Promise<string> => {
      if (hasLogoFile) return "";
      const p = prompts.logo?.trim();
      if (!p) return "";
      const settled = await Promise.allSettled([openRouterGenerateImageBuffer(apiKey, p, "1:1")]);
      const buf = settled[0].status === "fulfilled" ? settled[0].value : null;
      if (!buf) return "";
      try {
        await uploadPng(env, `${prefix}/logo.png`, buf);
        return publicAssetUrl(env, shopSlug, "logo.png");
      } catch (e) {
        console.error("[pivot-parlor-images] Logo R2 upload failed", e);
        return "";
      }
    })();

    const [heroSettled, logoSettled] = await Promise.allSettled([heroTask, logoTask]);
    const heroUrl = heroSettled.status === "fulfilled" ? heroSettled.value : "";
    const logoUrl = logoSettled.status === "fulfilled" ? logoSettled.value : "";

    const catalogUrls: string[] = [];
    const catalogSettled = await Promise.allSettled(
      prompts.catalog.map(async (prompt, i) => {
        const p = prompt?.trim();
        if (!p) return "";
        const gen = await Promise.allSettled([openRouterGenerateImageBuffer(apiKey, p, "1:1")]);
        const buf = gen[0].status === "fulfilled" ? gen[0].value : null;
        if (!buf) return "";
        const filename = `catalog-${i}.png`;
        try {
          await uploadPng(env, `${prefix}/${filename}`, buf);
          return publicAssetUrl(env, shopSlug, filename);
        } catch (e) {
          console.error("[pivot-parlor-images] Catalog R2 upload failed", i, e);
          return "";
        }
      })
    );
    for (const s of catalogSettled) {
      catalogUrls.push(s.status === "fulfilled" ? s.value : "");
    }

    const buildPayload = { heroUrl, logoUrl, catalogUrls };
    await updateGenerationJob(env.DB, jobId, {
      status: "running",
      stage: "assemble",
      build_output: JSON.stringify(buildPayload),
      error: null,
    });
    await putJobKv(env.KV, jobId, { status: "running", stage: "assemble", shopSlug });

    const researchOutput = mergeResearchOutputForDownstream(input, prompts);

    const assembleMessage: AssembleQueueMessage = {
      jobId: input.jobId,
      shopId: input.shopId,
      shopSlug: input.shopSlug,
      shopName: input.shopName,
      shopType: input.shopType,
      hasLogoFile: input.hasLogoFile,
      imageUrls: { hero: heroUrl, logo: logoUrl, catalog: catalogUrls },
      researchOutput,
    };

    await env.SITE_ASSEMBLE_QUEUE.send(assembleMessage);
  } catch (err) {
    const msg = errorMessage(err);
    console.error("[pivot-parlor-images] Job failed", jobId, err);
    try {
      await updateGenerationJob(env.DB, jobId, { status: "failed", error: msg });
      await putJobKv(env.KV, jobId, { status: "failed", error: msg, shopSlug });
    } catch (persistErr) {
      console.error("[pivot-parlor-images] Failed to persist failure", persistErr);
    }
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processOneMessage(msg.body, env);
      } catch (err) {
        console.error("[pivot-parlor-images] Outer failure", err);
      } finally {
        msg.ack();
      }
    }
  },
};
