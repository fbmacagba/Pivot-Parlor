/**
 * pivot-parlor-text — Consumes site-text-queue: OpenRouter copy → KV gen:{jobId}:text → site-assemble-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITE_ASSEMBLE_QUEUE: Queue;
  OPENROUTER_API_KEY: string;
  ENVIRONMENT: string;
}

export interface StageMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
  text_model?: string;
}

interface GenResearchKvPayload {
  spec: Record<string, unknown>;
  services: Array<{ name: string; price_gbp: number; duration_min: number }>;
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

export interface TextServiceOut {
  name: string;
  price_gbp: number;
  duration_minutes: number;
  description: string;
  image_prompt: string;
}

export interface TextKvPayload {
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

const DEFAULT_TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
const KV_TTL_SEC = 3600;

const genResearchKey = (jobId: string) => `gen:${jobId}:research`;
const genTextKey = (jobId: string) => `gen:${jobId}:text`;

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function maxTokensForOpenRouterModel(model: string): number {
  const m = model.trim().toLowerCase();
  if (m.startsWith("meta-llama/")) return 4096;
  if (m.startsWith("google/gemini-3.1-flash-lite")) return 8000;
  return 4096;
}

function parseStageMessage(body: unknown): StageMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string" || typeof o.shopSlug !== "string") return null;
  const text_model =
    typeof o.text_model === "string" && o.text_model.trim() ? o.text_model.trim() : undefined;
  return { jobId: o.jobId, shopId: o.shopId, shopSlug: o.shopSlug, text_model };
}

async function openRouterJson(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://pivotparlor.com",
      "X-Title": "Pivot Parlor Text",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokensForOpenRouterModel(model),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (data.choices[0]?.message?.content ?? "{}").trim().replace(/```json|```/g, "").trim();
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function validateTextOut(raw: unknown): raw is TextKvPayload {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.headline !== "string" || !o.headline.trim()) return false;
  if (wordCount(o.headline) > 10) return false;
  if (typeof o.tagline !== "string" || !o.tagline.trim()) return false;
  if (wordCount(o.tagline) > 20) return false;
  if (typeof o.about !== "string" || !o.about.trim()) return false;
  if (typeof o.seo_title !== "string" || !o.seo_title.trim()) return false;
  if (typeof o.seo_description !== "string" || !o.seo_description.trim()) return false;
  if (typeof o.color_primary !== "string" || !HEX6.test(o.color_primary)) return false;
  if (typeof o.color_accent !== "string" || !HEX6.test(o.color_accent)) return false;
  if (typeof o.font_heading !== "string" || !o.font_heading.trim()) return false;
  if (typeof o.font_body !== "string" || !o.font_body.trim()) return false;
  if (!Array.isArray(o.services) || o.services.length < 2) return false;
  for (const s of o.services) {
    if (!s || typeof s !== "object") return false;
    const sv = s as Record<string, unknown>;
    if (typeof sv.name !== "string" || !sv.name.trim()) return false;
    if (typeof sv.price_gbp !== "number" || Number.isNaN(sv.price_gbp)) return false;
    if (typeof sv.duration_minutes !== "number" || Number.isNaN(sv.duration_minutes)) return false;
    if (typeof sv.description !== "string") return false;
    if (typeof sv.image_prompt !== "string") return false;
  }
  return true;
}

function padServices(shopType: string, existing: TextServiceOut[]): TextServiceOut[] {
  const out = [...existing];
  let n = 0;
  while (out.length < 2) {
    n += 1;
    out.push({
      name: `Default service ${n}`,
      price_gbp: 25,
      duration_minutes: 30,
      description: `Popular ${shopType.replace(/_/g, " ")} treatment. Book online.`,
      image_prompt: `Professional ${shopType} service product shot, square, studio lighting, clean background`,
    });
  }
  return out;
}

function fallbackFromResearch(research: GenResearchKvPayload): TextKvPayload {
  const spec = research.spec;
  const content = spec.content as Record<string, unknown> | undefined;
  const palette = spec.palette as Record<string, unknown> | undefined;
  const typo = spec.typography as Record<string, unknown> | undefined;
  const img = spec.image_prompts as { catalog?: string[] } | undefined;
  const services: TextServiceOut[] = research.services.map((s, i) => ({
    name: s.name,
    price_gbp: s.price_gbp,
    duration_minutes: s.duration_min,
    description: `Professional ${s.name} at ${research.shopName}. Book online in seconds.`,
    image_prompt: typeof img?.catalog?.[i] === "string" ? img.catalog[i]! : `Square product photo for ${s.name}`,
  }));
  return {
    headline: typeof content?.headline === "string" ? content.headline : research.shopName,
    tagline: typeof content?.subheadline === "string" ? content.subheadline : "Book your appointment online",
    about:
      typeof content?.about_body === "string"
        ? content.about_body
        : `Welcome to ${research.shopName}. We look forward to seeing you.`,
    services: padServices(research.shopType, services),
    seo_title: typeof content?.seo_title === "string" ? content.seo_title : `${research.shopName} — Book online`,
    seo_description:
      typeof content?.seo_description === "string" ? content.seo_description : `Book at ${research.shopName} in a few clicks.`,
    color_primary: typeof palette?.primary === "string" && HEX6.test(palette.primary) ? palette.primary : "#1a1a1a",
    color_accent: typeof palette?.accent === "string" && HEX6.test(palette.accent) ? palette.accent : "#C9A84C",
    font_heading: typeof typo?.heading_font === "string" ? typo.heading_font : "Playfair Display",
    font_body: typeof typo?.body_font === "string" ? typo.body_font : "DM Sans",
    completedAt: new Date().toISOString(),
  };
}

async function processOne(body: unknown, env: Env): Promise<void> {
  const msg = parseStageMessage(body);
  if (!msg) {
    console.error("[pivot-parlor-text] invalid message", body);
    return;
  }
  const { jobId } = msg;
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(`[${jobId}] [pivot-parlor-text] OPENROUTER_API_KEY missing`);
    return;
  }

  const researchRaw = await env.KV.get(genResearchKey(jobId));
  if (!researchRaw) {
    console.error(`[${jobId}] [pivot-parlor-text] missing KV ${genResearchKey(jobId)}`);
    return;
  }

  let research: GenResearchKvPayload;
  try {
    research = JSON.parse(researchRaw) as GenResearchKvPayload;
  } catch {
    console.error(`[${jobId}] [pivot-parlor-text] bad research JSON`);
    return;
  }

  const servicesJson = JSON.stringify(research.services);
  const specJson = JSON.stringify(research.spec).slice(0, 12000);

  const system = `You output JSON only for a barber/beauty shop website. Obey word limits exactly. Colours must be 6-digit hex like #1a2b3c.`;

  const user = `Shop name: ${research.shopName}
Shop type: ${research.shopType}
Research spec (for style — do not copy long legal text): ${specJson}

Source services (name, price_gbp, duration_min) — keep these names and prices unless you must merge duplicates:
${servicesJson}

Return JSON:
{
  "headline": string (max 10 words),
  "tagline": string (max 20 words),
  "about": string (2-3 sentences, warm owner voice),
  "services": [{
    "name": string,
    "price_gbp": number,
    "duration_minutes": number,
    "description": string (one sentence),
    "image_prompt": string (square product/style photo prompt)
  }]  (at least 2 items; align with source services where possible),
  "seo_title": string (max 60 chars),
  "seo_description": string (max 155 chars),
  "color_primary": string (hex),
  "color_accent": string (hex),
  "font_heading": string (Google Font),
  "font_body": string (Google Font)
}

If source services are missing or empty, invent exactly 3 plausible services for this shop type.`;

  const textModel = msg.text_model?.trim() || research.text_model?.trim() || DEFAULT_TEXT_MODEL;
  console.log(`[${jobId}] [pivot-parlor-text] calling OpenRouter model=${textModel}`);

  let payload: TextKvPayload;
  try {
    const raw = await openRouterJson(apiKey, textModel, system, user);
    const parsed: unknown = JSON.parse(raw);
    if (validateTextOut(parsed)) {
      parsed.services = padServices(research.shopType, parsed.services);
      parsed.completedAt = new Date().toISOString();
      payload = parsed;
    } else {
      console.warn(`[${jobId}] [pivot-parlor-text] model output invalid, using research fallback`);
      payload = fallbackFromResearch(research);
    }
  } catch (e) {
    console.error(`[${jobId}] [pivot-parlor-text] OpenRouter failed`, e);
    payload = fallbackFromResearch(research);
  }

  await env.KV.put(genTextKey(jobId), JSON.stringify(payload), { expirationTtl: KV_TTL_SEC });
  console.log(
    `[${jobId}] [pivot-parlor-text] wrote KV ${genTextKey(jobId)} services=${payload.services.length} headline="${payload.headline.slice(0, 40)}..."`
  );

  await env.SITE_ASSEMBLE_QUEUE.send({ jobId: msg.jobId, shopId: msg.shopId, shopSlug: msg.shopSlug });
  console.log(`[${jobId}] [pivot-parlor-text] enqueued site-assemble-queue`);
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await processOne(m.body, env);
      } catch (e) {
        console.error("[pivot-parlor-text] outer failure", e);
      } finally {
        m.ack();
      }
    }
  },
};
