/**
 * pivot-parlor-research — Consumes site-research-queue: OpenRouter spec → D1 + KV → site-images-queue + site-text-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITE_IMAGES_QUEUE: Queue;
  SITE_TEXT_QUEUE: Queue;
  SITE_ASSEMBLE_QUEUE: Queue;
  OPENROUTER_API_KEY: string;
  ENVIRONMENT: string;
}

export interface ResearchQueueMessage {
  jobId: string;
  shopId: string;
  shopName: string;
  shopType: "barber_shop" | "beauty_parlor" | "both";
  shopSlug: string;
  styleNotes: string;
  services: { name: string; price_gbp: number; duration_min: number }[];
  hasLogoFile: boolean;
  text_model: string;
  image_model: string;
  skip_images?: boolean;
  /** Owner-chosen palette override (6-digit hex). Honoured only as a complete pair. */
  color_primary?: string;
  color_accent?: string;
}

export interface ResearchSpec {
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
  image_prompts: {
    hero: string;
    logo: string;
    catalog: string[];
  };
  legal_content: {
    privacy_policy: string;
    terms_of_service: string;
    cookie_policy: string;
  };
  social_stubs: Record<string, string>;
}

/** Stored at gen:{jobId}:research (TTL 1h) for images + text workers. */
export interface GenResearchKvPayload {
  spec: ResearchSpec;
  services: { name: string; price_gbp: number; duration_min: number }[];
  jobId: string;
  shopId: string;
  shopSlug: string;
  shopName: string;
  shopType: string;
  hasLogoFile: boolean;
  template: string;
  text_model: string;
  image_model: string;
  /** Owner-chosen palette override forwarded to the text worker (6-digit hex pair). */
  owner_color_primary?: string;
  owner_color_accent?: string;
}

const KV_TTL_SEC = 3600;
const genResearchKey = (jobId: string) => `gen:${jobId}:research`;
const genImagesKey = (jobId: string) => `gen:${jobId}:images`;

const DEFAULT_TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";

const LAYOUT_MOOD_TO_TEMPLATE: Record<string, string> = {
  "luxury-dark": "luxury",
  "modern-minimal": "minimal",
  "bold-vibrant": "vibrant",
  "warm-editorial": "editorial",
  "classic-traditional": "classic",
  "fresh-pastel": "fresh",
};

const SYSTEM_PROMPT =
  "You are a world-class brand strategist and visual designer specialising in barber shops and beauty salons. Your job is to produce a complete visual identity and content specification for a high-converting booking website. You have deep knowledge of what makes barber and beauty shop websites convert visitors into bookings. Return valid JSON only. No markdown. No backticks. No explanation.";

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
    research_output?: string | null;
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
  if (patch.research_output !== undefined) {
    sets.push("research_output = ?");
    vals.push(patch.research_output);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  vals.push(id);
  await db.prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

function buildUserPrompt(msg: ResearchQueueMessage): string {
  const servicesText = msg.services.map((s) => `${s.name} (£${s.price_gbp}, ${s.duration_min} min)`).join("; ");
  const style = msg.styleNotes?.trim() || "not provided";
  return `Shop name: ${msg.shopName}
Shop type: ${msg.shopType}
Style notes from owner: ${style}
Services offered: ${servicesText || "none listed"}
Has existing logo: ${msg.hasLogoFile}

Produce a complete visual and content specification. Return this exact JSON structure with no other text:
{
  "palette": {
    "primary": string (hex — dominant brand colour, chosen to match shop personality and style notes),
    "accent": string (hex — complementary CTA colour, high contrast with primary, draws the eye),
    "background": string (hex — page background, usually near-white or very dark),
    "text": string (hex — body text colour),
    "muted": string (hex — secondary text, captions)
  },
  "typography": {
    "heading_font": string (Google Font name — matches brand personality),
    "body_font": string (Google Font name — highly readable, pairs well with heading),
    "heading_weight": string (e.g. 700 or 800),
    "heading_style": string (e.g. serif, sans-serif)
  },
  "layout_mood": string (one of: luxury-dark, modern-minimal, bold-vibrant, warm-editorial, classic-traditional, fresh-pastel),
  "brand_voice": string (2 sentences describing the shop tone — e.g. authoritative and premium, warm and community-focused),
  "content": {
    "headline": string (max 8 words, punchy, benefit-focused),
    "subheadline": string (max 18 words, expands on headline, includes shop personality),
    "hero_cta": string (max 4 words, action-oriented e.g. Book Your Cut),
    "about_title": string (max 6 words),
    "about_body": string (3 sentences written as the shop owner, warm and personal, mentions speciality),
    "trust_signals": string[] (exactly 3 items, specific and credible e.g. 500+ happy clients, Walk-ins welcome, 5-star rated on Google),
    "unique_selling_points": string[] (exactly 3 items, max 8 words each, what makes this shop different),
    "seo_title": string (max 60 chars, includes shop name and location type),
    "seo_description": string (max 155 chars, includes booking CTA)
  },
  "image_prompts": {
    "hero": string (detailed photorealistic prompt for a hero background image — full-bleed barbershop or beauty salon atmosphere matching the layout_mood and palette, no people visible, focus on ambiance, lighting, textures),
    "logo": string (detailed prompt for a professional logo — style matching layout_mood, includes shop name, clean and scalable, white background),
    "catalog": string[] (one prompt per service in the input services array — each prompt describes a clean product/style photography shot for that specific service, square format, professional lighting)
  },
  "legal_content": {
    "privacy_policy": string (full GDPR and UK PECR compliant privacy policy for a barber/beauty booking platform — includes: data collected, how used, cookies, third parties, customer rights, contact details placeholder, shop name inserted throughout),
    "terms_of_service": string (full terms covering: booking policy, cancellation policy (24 hours notice required), refund policy, service descriptions, liability, governing law UK),
    "cookie_policy": string (explains: essential cookies (session, auth), analytics cookies (optional), marketing cookies (optional), how to manage consent, references pivotparlor.com platform)
  },
  "social_stubs": {
    "instagram_url": "",
    "facebook_url": "",
    "tiktok_url": "",
    "twitter_url": "",
    "youtube_url": "",
    "whatsapp_url": "",
    "linkedin_url": ""
  }
}

You MUST include exactly ${msg.services.length} strings in image_prompts.catalog (same order as services listed above).`;
}

function maxTokensForOpenRouterModel(model: string): number {
  const m = model.trim().toLowerCase();
  if (m.startsWith("meta-llama/")) return 4096;
  if (m.startsWith("google/gemini-3.1-flash-lite")) return 8000;
  return 4096;
}

async function openRouterJson(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://pivotparlor.com",
      "X-Title": "Pivot Parlor Research",
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
    throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (data.choices[0]?.message?.content ?? "{}").trim().replace(/```json|```/g, "").trim();
}

function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
}

function validateResearchSpec(raw: unknown, serviceCount: number): raw is ResearchSpec {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  const palette = o.palette;
  if (!palette || typeof palette !== "object") return false;
  const p = palette as Record<string, unknown>;
  if (!isHexColor(p.primary) || !isHexColor(p.accent) || !isHexColor(p.background) || !isHexColor(p.text) || !isHexColor(p.muted)) {
    return false;
  }
  const typo = o.typography;
  if (!typo || typeof typo !== "object") return false;
  const t = typo as Record<string, unknown>;
  if (typeof t.heading_font !== "string" || typeof t.body_font !== "string") return false;
  if (typeof t.heading_weight !== "string" || typeof t.heading_style !== "string") return false;
  if (typeof o.layout_mood !== "string" || typeof o.brand_voice !== "string") return false;
  const content = o.content;
  if (!content || typeof content !== "object") return false;
  const c = content as Record<string, unknown>;
  const strKeys = [
    "headline",
    "subheadline",
    "hero_cta",
    "about_title",
    "about_body",
    "seo_title",
    "seo_description",
  ] as const;
  for (const k of strKeys) {
    if (typeof c[k] !== "string") return false;
  }
  if (!Array.isArray(c.trust_signals) || c.trust_signals.length !== 3) return false;
  if (!c.trust_signals.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(c.unique_selling_points) || c.unique_selling_points.length !== 3) return false;
  if (!c.unique_selling_points.every((x) => typeof x === "string")) return false;
  const img = o.image_prompts;
  if (!img || typeof img !== "object") return false;
  const im = img as Record<string, unknown>;
  if (typeof im.hero !== "string" || typeof im.logo !== "string") return false;
  if (!Array.isArray(im.catalog) || im.catalog.length !== serviceCount) return false;
  if (!im.catalog.every((x) => typeof x === "string")) return false;
  const legal = o.legal_content;
  if (!legal || typeof legal !== "object") return false;
  const l = legal as Record<string, unknown>;
  if (typeof l.privacy_policy !== "string" || typeof l.terms_of_service !== "string" || typeof l.cookie_policy !== "string") {
    return false;
  }
  if (!o.social_stubs || typeof o.social_stubs !== "object") return false;
  return true;
}

function templateFromLayoutMood(layoutMood: string): string {
  return LAYOUT_MOOD_TO_TEMPLATE[layoutMood] ?? "minimal";
}

function parseInput(body: unknown): ResearchQueueMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string") return null;
  if (typeof o.shopName !== "string" || typeof o.shopSlug !== "string") return null;
  if (o.shopType !== "barber_shop" && o.shopType !== "beauty_parlor" && o.shopType !== "both") return null;
  if (typeof o.styleNotes !== "string") return null;
  if (typeof o.hasLogoFile !== "boolean") return null;
  if (!Array.isArray(o.services)) return null;
  const services: ResearchQueueMessage["services"] = [];
  for (const s of o.services) {
    if (!s || typeof s !== "object") return null;
    const sv = s as Record<string, unknown>;
    if (typeof sv.name !== "string" || typeof sv.price_gbp !== "number" || typeof sv.duration_min !== "number") return null;
    services.push({ name: sv.name, price_gbp: sv.price_gbp, duration_min: sv.duration_min });
  }
  if (services.length < 2) return null;
  const text_model =
    typeof o.text_model === "string" && o.text_model.trim() ? o.text_model.trim() : DEFAULT_TEXT_MODEL;
  const image_model =
    typeof o.image_model === "string" && o.image_model.trim() ? o.image_model.trim() : DEFAULT_IMAGE_MODEL;
  const skip_images = o.skip_images === true;
  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  const op = typeof o.color_primary === "string" && HEX6.test(o.color_primary.trim()) ? o.color_primary.trim() : undefined;
  const oa = typeof o.color_accent === "string" && HEX6.test(o.color_accent.trim()) ? o.color_accent.trim() : undefined;
  const hasColorOverride = Boolean(op && oa);
  return {
    jobId: o.jobId,
    shopId: o.shopId,
    shopName: o.shopName,
    shopType: o.shopType,
    shopSlug: o.shopSlug,
    styleNotes: o.styleNotes,
    services,
    hasLogoFile: o.hasLogoFile,
    text_model,
    image_model,
    skip_images,
    ...(hasColorOverride ? { color_primary: op, color_accent: oa } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function processOneMessage(body: unknown, env: Env): Promise<void> {
  const input = parseInput(body);
  if (!input) {
    console.error("[pivot-parlor-research] Invalid queue message shape", body);
    return;
  }

  const { jobId, shopId } = input;
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const msg = "OPENROUTER_API_KEY is not configured";
    try {
      await updateGenerationJob(env.DB, jobId, { status: "failed", error: msg });
      await putJobKv(env.KV, jobId, { status: "failed", error: msg, shopSlug: input.shopSlug });
    } catch (e) {
      console.error("[pivot-parlor-research] Failed to persist config error", e);
    }
    return;
  }

  try {
    console.log(`[${jobId}] [pivot-parlor-research] start shopSlug=${input.shopSlug}`);
    await updateGenerationJob(env.DB, jobId, { status: "running", stage: "research", error: null });
    await putJobKv(env.KV, jobId, { status: "running", stage: "research", shopSlug: input.shopSlug });

    const userPrompt = buildUserPrompt(input);
    console.log(`[${jobId}] [pivot-parlor-research] text model=${input.text_model}`);
    const rawText = await openRouterJson(apiKey, input.text_model, SYSTEM_PROMPT, userPrompt);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      await updateGenerationJob(env.DB, jobId, {
        status: "failed",
        error: "Research worker returned invalid JSON",
      });
      await putJobKv(env.KV, jobId, {
        status: "failed",
        error: "Research worker returned invalid JSON",
        shopSlug: input.shopSlug,
      });
      return;
    }

    if (!validateResearchSpec(parsed, input.services.length)) {
      await updateGenerationJob(env.DB, jobId, {
        status: "failed",
        error: "Research worker returned invalid JSON",
      });
      await putJobKv(env.KV, jobId, {
        status: "failed",
        error: "Research worker returned invalid JSON",
        shopSlug: input.shopSlug,
      });
      return;
    }

    const spec = parsed;
    // Honour an owner-chosen palette: overwrite the AI palette so the text
    // worker's research fallback and any spec consumer see the chosen colours.
    // The text worker re-applies the same override after its own copy pass,
    // which is what ultimately reaches the builder.
    if (input.color_primary && input.color_accent) {
      spec.palette.primary = input.color_primary;
      spec.palette.accent = input.color_accent;
    }
    const fullJson = JSON.stringify(spec);

    const payload: GenResearchKvPayload = {
      spec,
      services: input.services.map((s) => ({
        name: s.name,
        price_gbp: s.price_gbp,
        duration_min: s.duration_min,
      })),
      jobId,
      shopId,
      shopSlug: input.shopSlug,
      shopName: input.shopName,
      shopType: input.shopType,
      hasLogoFile: input.hasLogoFile,
      template: templateFromLayoutMood(spec.layout_mood),
      text_model: input.text_model,
      image_model: input.image_model,
      ...(input.color_primary && input.color_accent
        ? { owner_color_primary: input.color_primary, owner_color_accent: input.color_accent }
        : {}),
    };

    await env.KV.put(genResearchKey(jobId), JSON.stringify(payload), { expirationTtl: KV_TTL_SEC });
    console.log(`[${jobId}] [pivot-parlor-research] wrote KV ${genResearchKey(jobId)} ttl=${KV_TTL_SEC}s`);

    await updateGenerationJob(env.DB, jobId, {
      status: "running",
      stage: "parallel",
      research_output: fullJson,
      error: null,
    });
    await putJobKv(env.KV, jobId, { status: "running", stage: "parallel", shopSlug: input.shopSlug });

    if (input.skip_images) {
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
          if (Array.isArray(p)) {
            catalogUrls = p.filter((x): x is string => typeof x === "string");
          }
        } catch {
          /* ignore */
        }
      }
      const imagesPayload = {
        heroUrl: row?.hero_image_url?.trim() ?? "",
        logoUrl: row?.logo_url?.trim() ?? "",
        catalogUrls,
        completedAt: new Date().toISOString(),
        errors: [] as { step: string; detail: string }[],
      };
      await env.KV.put(genImagesKey(jobId), JSON.stringify(imagesPayload), { expirationTtl: KV_TTL_SEC });
      await env.SITE_ASSEMBLE_QUEUE.send({
        jobId,
        shopId,
        shopSlug: input.shopSlug,
      });
      console.log(`[${jobId}] [pivot-parlor-research] skip_images: wrote ${genImagesKey(jobId)} + site-assemble-queue`);
    } else {
      await env.SITE_IMAGES_QUEUE.send({
        jobId,
        shopId,
        shopSlug: input.shopSlug,
        image_model: input.image_model,
      });
      console.log(`[${jobId}] [pivot-parlor-research] enqueued site-images-queue`);
    }

    await env.SITE_TEXT_QUEUE.send({
      jobId,
      shopId,
      shopSlug: input.shopSlug,
      text_model: input.text_model,
    });
    console.log(`[${jobId}] [pivot-parlor-research] enqueued site-text-queue`);
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[${jobId}] [pivot-parlor-research] Job failed`, err);
    try {
      await updateGenerationJob(env.DB, jobId, { status: "failed", error: msg });
      await putJobKv(env.KV, jobId, { status: "failed", error: msg, shopSlug: input.shopSlug });
    } catch (persistErr) {
      console.error("[pivot-parlor-research] Failed to persist job failure", persistErr);
    }
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processOneMessage(msg.body, env);
      } catch (err) {
        console.error("[pivot-parlor-research] Unexpected outer failure", err);
      } finally {
        msg.ack();
      }
    }
  },
};
