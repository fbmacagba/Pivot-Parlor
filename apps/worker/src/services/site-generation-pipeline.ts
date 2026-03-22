/**
 * 3-stage async site generation: research → build → audit (Cloudflare Queues).
 */
import type { D1Database, KVNamespace, R2Bucket, Queue } from "@cloudflare/workers-types";
import {
  getShopById,
  getGenerationJobById,
  updateGenerationJob,
  replaceShopSiteForShop,
  getShopSiteByShopId,
  setShopActive,
} from "../db/queries.js";
import { generateOpenRouterImageBuffer } from "./openrouter-image-generation.js";

const TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
const SITE_KV_TTL = 60 * 60 * 24;

export interface ResearchQueuePayload {
  jobId: string;
  shopId: string;
  shopName: string;
  shopType: string;
  shopSlug: string;
  template: string;
  color_primary?: string;
  color_accent?: string;
  design_notes?: string;
}

export interface BuildQueuePayload {
  jobId: string;
  shopId: string;
  shopSlug: string;
  template: string;
  researchOutput: ResearchOutput;
  hasLogoFile: boolean;
  design_notes?: string;
  owner_color_primary?: string;
  owner_color_accent?: string;
}

export interface AuditQueuePayload {
  jobId: string;
  shopId: string;
  shopSlug: string;
}

export interface ResearchOutput {
  positioning: string;
  headline: string;
  subheadline: string;
  hero_cta: string;
  about_title: string;
  about_body: string;
  unique_selling_points: string[];
  services: Array<{
    name: string;
    duration_minutes: number;
    price_gbp: number;
    description: string;
    image_prompt: string;
  }>;
  hero_image_prompt: string;
  logo_prompt: string;
  color_primary: string;
  color_accent: string;
  font_heading: string;
  font_body: string;
  seo_title: string;
  seo_description: string;
  trust_signals: string[];
}

const VALID_TEMPLATES = new Set(["minimal", "luxury", "vibrant", "editorial", "classic", "fresh"]);

function jobKvKey(jobId: string) {
  return `job:${jobId}`;
}

async function putJobKv(
  kv: KVNamespace,
  jobId: string,
  data: Record<string, unknown>
) {
  await kv.put(jobKvKey(jobId), JSON.stringify(data));
}

async function openRouterJson(
  apiKey: string,
  system: string,
  user: string,
  responseFormatJson = true
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://pivotparlor.com",
      "X-Title": "Pivot Parlor",
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      max_tokens: 4096,
      ...(responseFormatJson ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter text error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (data.choices[0]?.message?.content ?? "{}").trim().replace(/```json|```/g, "").trim();
}

function validateResearchOutput(raw: unknown): raw is ResearchOutput {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  const need = [
    "positioning",
    "headline",
    "subheadline",
    "hero_cta",
    "about_title",
    "about_body",
    "hero_image_prompt",
    "logo_prompt",
    "color_primary",
    "color_accent",
    "font_heading",
    "font_body",
    "seo_title",
    "seo_description",
  ];
  for (const k of need) {
    if (typeof o[k] !== "string") return false;
  }
  if (!Array.isArray(o.unique_selling_points) || o.unique_selling_points.length !== 3) return false;
  if (!Array.isArray(o.trust_signals) || o.trust_signals.length !== 3) return false;
  if (!Array.isArray(o.services) || o.services.length < 2) return false;
  for (const s of o.services as unknown[]) {
    if (!s || typeof s !== "object") return false;
    const sv = s as Record<string, unknown>;
    if (typeof sv.name !== "string") return false;
    if (typeof sv.duration_minutes !== "number") return false;
    if (typeof sv.price_gbp !== "number") return false;
    if (typeof sv.description !== "string") return false;
    if (typeof sv.image_prompt !== "string") return false;
  }
  return true;
}

/** Minimal bindings for pipeline stages (avoids circular import with index.ts). */
export type PipelineBindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: R2Bucket;
  OPENROUTER_API_KEY: string;
  ASSET_BASE_URL?: string;
  site_research_queue: Queue;
  site_build_queue: Queue;
  site_audit_queue: Queue;
};

export async function processSiteResearchMessage(
  payload: ResearchQueuePayload,
  env: PipelineBindings
): Promise<void> {
  const { jobId, shopId, shopName, shopType, shopSlug, template, color_primary, color_accent, design_notes } =
    payload;
  const db = env.DB;
  const kv = env.KV;
  const apiKey = env.OPENROUTER_API_KEY;

  await updateGenerationJob(db, jobId, { status: "running", stage: "research" });
  await putJobKv(kv, jobId, { status: "running", stage: "research", shopSlug });

  const typeLabel = shopType.replace(/_/g, " ");
  const notes = design_notes?.trim() || "not provided";
  const userPrompt = `Shop name: ${shopName}
Shop type: ${typeLabel}
URL slug: ${shopSlug}
Owner-selected template (context only; the website template is applied in a later step): ${template}
Owner primary colour (hex, honour if provided): ${color_primary || "not provided"}
Owner accent colour (hex, honour if provided): ${color_accent || "not provided"}
Design notes from owner: ${notes}

Return a single JSON object with EXACTLY these keys and constraints:
{
  "positioning": string,
  "headline": string (max 8 words),
  "subheadline": string (max 15 words),
  "hero_cta": string (max 4 words),
  "about_title": string,
  "about_body": string (3 sentences as shop owner voice),
  "unique_selling_points": string[] (exactly 3 items),
  "services": [{ "name": string, "duration_minutes": number, "price_gbp": number, "description": string, "image_prompt": string }] (at least 3 services),
  "hero_image_prompt": string (detailed photorealistic prompt),
  "logo_prompt": string (detailed logo generation prompt),
  "color_primary": string (hex, honour owner input if provided),
  "color_accent": string (hex, honour owner input if provided),
  "font_heading": string (Google Font name),
  "font_body": string (Google Font name),
  "seo_title": string (max 60 chars),
  "seo_description": string (max 155 chars),
  "trust_signals": string[] (exactly 3 items)
}`;

  const system =
    'You are a conversion-focused web strategist for barbershop and beauty salon websites. Return valid JSON only. No markdown, no backticks.';

  let research: ResearchOutput;
  try {
    const rawText = await openRouterJson(apiKey, system, userPrompt, true);
    const parsed: unknown = JSON.parse(rawText);
    if (!validateResearchOutput(parsed)) {
      throw new Error("invalid shape");
    }
    research = parsed;
    if (color_primary?.trim() && /^#[0-9a-fA-F]{6}$/.test(color_primary.trim())) {
      research.color_primary = color_primary.trim();
    }
    if (color_accent?.trim() && /^#[0-9a-fA-F]{6}$/.test(color_accent.trim())) {
      research.color_accent = color_accent.trim();
    }
  } catch {
    await updateGenerationJob(db, jobId, {
      status: "failed",
      stage: "research",
      error: "Research agent returned invalid JSON",
    });
    await putJobKv(kv, jobId, {
      status: "failed",
      stage: "research",
      shopSlug,
      error: "Research agent returned invalid JSON",
    });
    return;
  }

  const researchJson = JSON.stringify(research);
  await updateGenerationJob(db, jobId, {
    research_output: researchJson,
    stage: "build",
    status: "running",
  });
  await putJobKv(kv, jobId, { status: "running", stage: "build", shopSlug });

  const logoUpload = await env.ASSETS.get(`shops/${shopSlug}/logo-upload`);
  const hasLogoFile = logoUpload !== null;

  const buildPayload: BuildQueuePayload = {
    jobId,
    shopId,
    shopSlug,
    template: VALID_TEMPLATES.has(template) ? template : "minimal",
    researchOutput: research,
    hasLogoFile,
    design_notes: design_notes?.trim() || undefined,
    owner_color_primary: color_primary?.trim() || undefined,
    owner_color_accent: color_accent?.trim() || undefined,
  };

  await env.site_build_queue.send(buildPayload);
}

export async function processSiteBuildMessage(payload: BuildQueuePayload, env: PipelineBindings): Promise<void> {
  const {
    jobId,
    shopId,
    shopSlug,
    template,
    researchOutput,
    hasLogoFile,
    design_notes,
    owner_color_primary,
    owner_color_accent,
  } = payload;
  const db = env.DB;
  const kv = env.KV;
  const r2 = env.ASSETS;
  const apiKey = env.OPENROUTER_API_KEY;
  const apiBase = env.ASSET_BASE_URL ?? "https://api.pivotparlor.com";

  await updateGenerationJob(db, jobId, { status: "running", stage: "build" });
  await putJobKv(kv, jobId, { status: "running", stage: "build", shopSlug });

  const r2Prefix = `shops/${shopSlug}`;
  const imageTasks: Promise<{ key: string; buf: ArrayBuffer; contentType: string }>[] = [];

  imageTasks.push(
    generateOpenRouterImageBuffer(researchOutput.hero_image_prompt, "16:9", apiKey, "[site-pipeline][hero]").then(
      (buf) => ({
        key: `${r2Prefix}/hero.png`,
        buf,
        contentType: "image/png",
      })
    )
  );

  if (!hasLogoFile) {
    imageTasks.push(
      generateOpenRouterImageBuffer(researchOutput.logo_prompt, "1:1", apiKey, "[site-pipeline][logo]").then(
        (buf) => ({
          key: `${r2Prefix}/logo.png`,
          buf,
          contentType: "image/png",
        })
      )
    );
  }

  for (let i = 0; i < researchOutput.services.length; i++) {
    const svc = researchOutput.services[i];
    if (!svc) continue;
    const idx = i;
    imageTasks.push(
      generateOpenRouterImageBuffer(
        `Clean product or style shot: ${svc.image_prompt}`,
        "1:1",
        apiKey,
        `[site-pipeline][catalog-${idx}]`
      ).then((buf) => ({
        key: `${r2Prefix}/catalog-${idx}.png`,
        buf,
        contentType: "image/png",
      }))
    );
  }

  const settled = await Promise.allSettled(imageTasks);
  const failures: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    if (!entry) continue;
    if (entry.status === "rejected") {
      const reason = entry.reason;
      failures.push(`image_${i}: ${reason instanceof Error ? reason.message : String(reason)}`);
    } else {
      try {
        const { key, buf, contentType } = entry.value;
        await r2.put(key, buf, { httpMetadata: { contentType } });
      } catch (e) {
        failures.push(
          `r2_${i}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  /** Empty string when missing so D1 is non-null and audit allows text-only sites. */
  let logoUrl = "";
  if (hasLogoFile) {
    const uploaded = await r2.get(`${r2Prefix}/logo-upload`);
    if (uploaded?.body) {
      try {
        const buf = await uploaded.arrayBuffer();
        const ct = uploaded.httpMetadata?.contentType ?? "image/png";
        await r2.put(`${r2Prefix}/logo.png`, buf, { httpMetadata: { contentType: ct } });
        logoUrl = `${apiBase}/assets/${shopSlug}/logo.png`;
      } catch (e) {
        console.error("[site-pipeline][build] logo-upload copy to logo.png failed:", e);
        logoUrl = "";
      }
    }
  } else {
    const logoIdx = 1;
    if (settled[logoIdx]?.status === "fulfilled") {
      logoUrl = `${apiBase}/assets/${shopSlug}/logo.png`;
    }
  }

  let heroUrl = "";
  if (settled[0]?.status === "fulfilled") {
    heroUrl = `${apiBase}/assets/${shopSlug}/hero.png`;
  }

  const catalogUrls: string[] = [];
  const catalogStart = hasLogoFile ? 1 : 2;
  for (let i = catalogStart; i < settled.length; i++) {
    const catIndex = i - catalogStart;
    if (settled[i]?.status === "fulfilled") {
      catalogUrls.push(`${apiBase}/assets/${shopSlug}/catalog-${catIndex}.png`);
    }
  }

  const servicesForDb = researchOutput.services.map((s) => ({
    name: s.name,
    duration_minutes: s.duration_minutes,
    price_gbp: s.price_gbp,
    description: s.description,
  }));

  const aboutText = researchOutput.about_title
    ? `${researchOutput.about_title}\n\n${researchOutput.about_body}`
    : researchOutput.about_body;

  const siteId = crypto.randomUUID();
  await replaceShopSiteForShop(db, {
    id: siteId,
    shop_id: shopId,
    template,
    headline: researchOutput.headline,
    tagline: researchOutput.subheadline,
    about: aboutText,
    services_json: JSON.stringify(servicesForDb),
    color_primary: researchOutput.color_primary,
    color_accent: researchOutput.color_accent,
    font_heading: researchOutput.font_heading,
    font_body: researchOutput.font_body,
    hero_image_url: heroUrl,
    logo_url: logoUrl,
    catalog_images_json: JSON.stringify(catalogUrls),
    generated_at: new Date().toISOString(),
    status: "active",
    design_notes: design_notes?.trim() || null,
    owner_color_primary: owner_color_primary?.trim() || null,
    owner_color_accent: owner_color_accent?.trim() || null,
  });

  const siteObj = {
    template,
    headline: researchOutput.headline,
    tagline: researchOutput.subheadline,
    about: aboutText,
    services: servicesForDb,
    color_primary: researchOutput.color_primary,
    color_accent: researchOutput.color_accent,
    font_heading: researchOutput.font_heading,
    font_body: researchOutput.font_body,
    hero_image_url: heroUrl,
    logo_url: logoUrl,
    catalog_images: catalogUrls,
  };

  await kv.put(`site:${shopSlug}`, JSON.stringify(siteObj), { expirationTtl: SITE_KV_TTL });

  const buildMeta = { failures, heroUrl, logoUrl, catalogCount: catalogUrls.length };
  await updateGenerationJob(db, jobId, {
    build_output: JSON.stringify(buildMeta),
    stage: "audit",
    status: "running",
  });
  await putJobKv(kv, jobId, { status: "running", stage: "audit", shopSlug });

  await env.site_audit_queue.send({ jobId, shopId, shopSlug } satisfies AuditQueuePayload);
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export async function processSiteAuditMessage(payload: AuditQueuePayload, env: PipelineBindings): Promise<void> {
  const { jobId, shopId, shopSlug } = payload;
  const db = env.DB;
  const kv = env.KV;

  await updateGenerationJob(db, jobId, { status: "running", stage: "audit" });
  await putJobKv(kv, jobId, { status: "running", stage: "audit", shopSlug });

  const job = await getGenerationJobById(db, jobId);
  let seoTitle = "";
  let seoDescription = "";
  if (job?.research_output) {
    try {
      const r = JSON.parse(job.research_output) as ResearchOutput;
      seoTitle = r.seo_title ?? "";
      seoDescription = r.seo_description ?? "";
    } catch {
      /* ignore */
    }
  }

  const site = await getShopSiteByShopId(db, shopId);
  const failed: string[] = [];

  if (!site?.headline?.trim()) failed.push("headline missing or empty");
  if (!site?.tagline?.trim()) failed.push("subheadline missing or empty");
  if (!site?.about || site.about.length <= 50) failed.push("about_body missing or too short");
  let servicesLen = 0;
  try {
    const arr = site?.services_json ? (JSON.parse(site.services_json) as unknown[]) : [];
    servicesLen = Array.isArray(arr) ? arr.length : 0;
  } catch {
    servicesLen = 0;
  }
  if (servicesLen < 2) failed.push("services must have at least 2 items");
  // Allow "" (text-only site when image gen failed); only NULL/undefined fails audit.
  if (site?.hero_image_url == null) failed.push("hero_image_url null (expected string, empty ok)");
  if (site?.logo_url == null) failed.push("logo_url null (expected string, empty ok)");
  if (!site?.color_primary || !HEX6.test(site.color_primary)) failed.push("color_primary invalid hex");
  if (!site?.template || !VALID_TEMPLATES.has(site.template)) failed.push("template invalid");
  if (!seoTitle.trim()) failed.push("seo_title missing");
  else if (seoTitle.length > 60) failed.push("seo_title too long");
  if (!seoDescription.trim()) failed.push("seo_description missing");
  else if (seoDescription.length > 155) failed.push("seo_description too long");

  if (failed.length === 0) {
    await updateGenerationJob(db, jobId, {
      status: "complete",
      stage: "done",
      audit_output: JSON.stringify({ ok: true }),
      error: null,
    });
    await putJobKv(kv, jobId, { status: "complete", stage: "done", shopSlug, error: null });
    await setShopActive(db, shopId);
    return;
  }

  const errJson = JSON.stringify(failed);
  await updateGenerationJob(db, jobId, {
    status: "failed",
    stage: "audit",
    error: errJson,
    audit_output: errJson,
  });
  await putJobKv(kv, jobId, { status: "failed", stage: "audit", shopSlug, error: errJson });
}
