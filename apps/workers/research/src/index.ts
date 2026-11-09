/**
 * pivot-parlor-research — Consumes site-research-queue: OpenRouter spec → D1 + KV → site-images-queue + site-text-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";
import {
  seedComposeDesignSpec,
  normalizeDesignSpec,
  parseComposer,
  TEMPLATE_HERO_CONSTRAINTS,
  HERO_VARIANTS,
  type DesignSpec,
  type ComposerId,
} from "./design-spec";
import { chatComplete, recordAiUsage, type ProviderKeys, type UsageCost } from "@repo/llm";
import {
  AuditWriteError,
  auditAiCall,
  finishJob,
  originActorRef,
  queueAudit,
  type AuditRecorder,
} from "@repo/audit";
import {
  alignServiceCopy,
  factSignals,
  formatFactsBlock,
  normalizeGalleryPrompts,
  parseBusiness,
  type ResearchBusiness,
} from "./facts";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITE_IMAGES_QUEUE: Queue;
  SITE_TEXT_QUEUE: Queue;
  SITE_ASSEMBLE_QUEUE: Queue;
  OPENROUTER_API_KEY: string;
  /** Direct-vendor keys; optional. A chosen direct model with no key falls back to the default model. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENVIRONMENT: string;
}

/** Reasoning-effort level for models that support it (OpenRouter `reasoning`). */
export type TextEffort = "low" | "medium" | "high";

export interface ResearchQueueMessage {
  jobId: string;
  shopId: string;
  shopName: string;
  shopType: "barber_shop" | "beauty_parlor" | "both";
  shopSlug: string;
  styleNotes: string;
  services: { name: string; price_gbp: number; duration_min: number; category?: string }[];
  /** Owner-entered facts (team, hours, area). Empty on older messages. */
  business: ResearchBusiness;
  hasLogoFile: boolean;
  text_model: string;
  text_effort?: TextEffort;
  image_model: string;
  skip_images?: boolean;
  /** Owner-chosen palette override (6-digit hex). Honoured only as a complete pair. */
  color_primary?: string;
  color_accent?: string;
  /** Owner-chosen template (WS-6) — pins layout_mood. Absent = model's choice. */
  template?: string;
  /** Design Director (v3) composer selection — "seed" skips the AI design_spec prompt. */
  composer?: ComposerId;
  /** Who clicked Regenerate (`subj_user_<id>`). Absent on messages from before the audit trail. */
  origin_actor_ref?: string | null;
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
    /** { [exact service name]: description }. Not validated here; aligned
     *  onto the real service names by alignServiceCopy. */
    service_copy?: unknown;
  };
  image_prompts: {
    hero: string;
    logo: string;
    catalog: string[];
    /** "The space" photos (interior, tools, detail); normalized to exactly 3. */
    gallery?: string[];
  };
  legal_content: {
    privacy_policy: string;
    terms_of_service: string;
    cookie_policy: string;
  };
  social_stubs: Record<string, string>;
  /** Design Director (v3) — not validated by validateResearchSpec; a bad
   *  design_spec must never fail the whole research spec (normalizeDesignSpec
   *  repairs it field by field against the seed fallback). */
  design_spec?: unknown;
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
  text_effort?: TextEffort;
  image_model: string;
  /** Owner-chosen palette override forwarded to the text worker (6-digit hex pair). */
  owner_color_primary?: string;
  owner_color_accent?: string;
  design_spec: DesignSpec;
  /** Owner-entered facts, forwarded so the text worker states only these. */
  business: ResearchBusiness;
  /** True trust lines from the records; the assembler fills the strip from
   *  these when generated items are dropped as unverifiable claims. */
  fact_signals: string[];
  /** Generated description per real service name (absent names: none). */
  service_copy: Record<string, string>;
  /** The owner's own notes: a claim they wrote here may be published. */
  style_notes: string;
  /** Who clicked Regenerate, carried to the later stages for their audit entries. */
  origin_actor_ref: string | null;
}

const WORKER_NAME = "pivot-parlor-research";
const KV_TTL_SEC = 3600;
const genResearchKey = (jobId: string) => `gen:${jobId}:research`;
const genImagesKey = (jobId: string) => `gen:${jobId}:images`;

const DEFAULT_TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image";

const LAYOUT_MOOD_TO_TEMPLATE: Record<string, string> = {
  "luxury-dark": "luxury",
  "modern-minimal": "minimal",
  "bold-vibrant": "vibrant",
  "warm-editorial": "editorial",
  "classic-traditional": "classic",
  "fresh-pastel": "fresh",
};

/** Reverse map: an owner-picked template pins the layout_mood (WS-6). */
const TEMPLATE_TO_LAYOUT_MOOD: Record<string, string> = {
  luxury: "luxury-dark",
  minimal: "modern-minimal",
  vibrant: "bold-vibrant",
  editorial: "warm-editorial",
  classic: "classic-traditional",
  fresh: "fresh-pastel",
};

function layoutMoodForTemplate(template: string | undefined): string | null {
  if (typeof template !== "string") return null;
  return TEMPLATE_TO_LAYOUT_MOOD[template.trim().toLowerCase()] ?? null;
}

// Curated typography (WS-6 item 5). KEEP IN SYNC with CURATED_FONTS in
// packages/utils/src/curatedFonts.ts — the web self-hosts exactly these
// families, so a font outside the set would silently fall back at render.
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

/** Map a model-proposed font onto the curated set (exact match keeps it;
 *  anything else falls to the role default, honouring a serif/sans hint). */
function coerceCuratedFont(name: string, role: "heading" | "body", styleHint: string): string {
  const wanted = name.trim().toLowerCase();
  const match = CURATED_FONT_NAMES.find((f) => f.toLowerCase() === wanted);
  if (match) return match;
  const h = styleHint.toLowerCase();
  // "sans-serif".includes("serif") is true — check sans first.
  const serif = !h.includes("sans") && h.includes("serif");
  if (role === "heading") return serif ? "Playfair Display" : "Montserrat";
  return serif ? "Lora" : "DM Sans";
}

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
  const servicesText = msg.services
    .map((s) => `${s.name} (${s.category ? `${s.category}, ` : ""}£${s.price_gbp}, ${s.duration_min} min)`)
    .join("; ");
  const facts = formatFactsBlock(msg.business, msg.services);
  const style = msg.styleNotes?.trim() || "not provided";
  const pinnedMood = layoutMoodForTemplate(msg.template);
  // Falls back to the full HERO_VARIANTS pool if a template key is ever
  // missing from TEMPLATE_HERO_CONSTRAINTS, so key-set drift can't throw here.
  const heroConstraint =
    TEMPLATE_HERO_CONSTRAINTS[(msg.template ?? "").trim().toLowerCase()] ?? HERO_VARIANTS;
  const moodLine = pinnedMood
    ? `The owner has explicitly chosen the "${msg.template}" template: layout_mood MUST be "${pinnedMood}", and the palette, typography and imagery must express that mood. The design_spec hero.variant must be one of: ${heroConstraint.join(", ")}.\n`
    : "";
  const designSpecBlock =
    msg.composer !== "seed"
      ? `,
  "design_spec": {
    "hero": { "variant": "full-bleed"|"split"|"editorial"|"minimal" (choose the treatment that best expresses this shop's character and the layout_mood), "motion": "parallax"|"fade"|"none" },
    "sections": [ ordered array covering EXACTLY these seven keys once each: trust, services, about, team, how, reviews, location. Each entry is {"key": string, "variant": string, "include": boolean}. Allowed variants: trust: icons|chips; services: grid|rows|showcase; about: standard|split-image|story; team: cards|strip; how: grid|row; reviews: cards|marquee|spotlight; location: standard|map-first. services and location must have include true. Order and exclusions should serve this shop's story. ],
    "motion": { "intensity": "calm"|"lively"|"off", "reveal": "fade-up"|"scale"|"slide" },
    "motif": "line"|"dot-grid"|"arc"|"none" (decorative accent motif),
    "signature": "gallery"|"marquee-reviews"|"spotlight"|null (at most one showpiece section),
    "density": "airy"|"compact"
  }`
      : "";
  // Depict the shop's typical clientele in the hero so a barber shop shows a
  // male client and a beauty parlor a female one (matches the per-service fix).
  const heroPeople =
    msg.shopType === "barber_shop"
      ? "a barber mid-service with a relaxed, happy male client"
      : msg.shopType === "beauty_parlor"
        ? "a stylist mid-service with a relaxed, happy female client"
        : "a barber or stylist mid-service with a relaxed, happy client";
  return `Shop name: ${msg.shopName}
Shop type: ${msg.shopType}
Style notes from owner: ${style}
Services offered: ${servicesText || "none listed"}
Has existing logo: ${msg.hasLogoFile}

Facts from the owner's records (the ONLY business facts you may state):
${facts}

Truthfulness rules for every piece of copy: state only the facts above and what the owner's style notes say. Never invent client or booking counts, star ratings, review scores, awards, rankings ("best", "#1", "top-rated"), years in business, founding dates, qualifications, guarantees, testimonials, celebrity clients or press. If a field would need such a claim, write something true and specific about the services, the team's specialisms, the area or the atmosphere instead.

${moodLine}Produce a complete visual and content specification. Return this exact JSON structure with no other text:
{
  "palette": {
    "primary": string (hex — dominant brand colour, chosen to match shop personality and style notes),
    "accent": string (hex — complementary CTA colour, high contrast with primary, draws the eye),
    "background": string (hex — page background, usually near-white or very dark),
    "text": string (hex — body text colour),
    "muted": string (hex — secondary text, captions)
  },
  "typography": {
    "heading_font": string (one of: ${CURATED_FONT_NAMES.join(", ")} — matches brand personality),
    "body_font": string (one of: DM Sans, Jost, Inter, Work Sans, Lora — highly readable, pairs well with heading),
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
    "about_body": string (3 to 4 sentences written as the shop owner, warm and personal, about what the shop is like and what the team specialises in, grounded only in the Facts and style notes),
    "trust_signals": string[] (exactly 3 short factual lines built only from the Facts, e.g. the opening days, how many team members a customer can choose from, the area, or that booking is online),
    "unique_selling_points": string[] (exactly 3 items, max 8 words each, what makes this shop different, drawn from its services, specialisms and style; no superlatives),
    "seo_title": string (max 60 chars, includes shop name and location type),
    "seo_description": string (max 155 chars, includes booking CTA),
    "service_copy": object (one key per service listed above, using its EXACT name; each value is one or two plain sentences, max 30 words, describing what the appointment involves and who it suits; no prices, no claims)
  },
  "image_prompts": {
    "hero": string (detailed photorealistic prompt for a full-bleed hero image featuring real people — ${heroPeople} — set in a barbershop or beauty salon that matches the layout_mood and palette; warm natural light, authentic candid moment, and leave clean negative space on one side or the top for an overlaid headline),
    "logo": string (detailed prompt for a professional logo — style matching layout_mood, includes shop name, clean and scalable, white background),
    "catalog": string[] (one prompt per service in the input services array, in the same order — each prompt describes the ACTUAL finished result of that specific service on a real person (a fresh haircut, a styled beard, a finished colour or style), photographed close and flattering so the style itself is clearly readable, square format, professional lighting),
    "gallery": string[] (exactly 3 photorealistic prompts showing the shop itself in the same art direction as the hero: the empty interior, a still life of tools or products on the counter, and one characterful detail; no people, no text, no signage, no logos)
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
  }${designSpecBlock}
}

You MUST include exactly ${msg.services.length} strings in image_prompts.catalog (same order as services listed above)${msg.services.length === 0 ? "; with no services listed, catalog is an empty array and service_copy is an empty object" : ""}.`;
}

/** One JSON-only completion through the shared client; HTTP retries and the
 *  effort retry live in the client, output validity is judged by the caller.
 *  Every answered call is written to the cost log, valid output or not: the
 *  tokens were spent either way. */
async function researchJson(
  jobId: string,
  keys: ProviderKeys,
  model: string,
  system: string,
  user: string,
  effort: TextEffort | undefined,
  costLog: { env: Pick<Env, "DB" | "KV">; shopId: string },
  audit: { rec: AuditRecorder; origin: string | null }
): Promise<string> {
  // The call and its cost-log write are one ai.call entry, so the outcome row
  // reuses the cost that was just recorded. A refused started write throws
  // AuditWriteError before the model is called.
  const { result } = await auditAiCall(
    audit.rec,
    { purpose: "site_research", model, shopId: costLog.shopId, origin: audit.origin },
    async () => {
      const result = await chatComplete(
        {
          modelId: model,
          system,
          messages: [{ role: "user", content: user }],
          effort,
          maxTokens: 8000,
          jsonOnly: true,
          appTitle: "Pivot Parlor Research",
        },
        keys
      );
      console.log(
        `[${jobId}] [pivot-parlor-research] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
      );
      const cost: UsageCost | null = await recordAiUsage(costLog.env, {
        shopId: costLog.shopId,
        workerName: WORKER_NAME,
        modelId: model,
        usageType: "site_research",
        usage: result.usage,
        jobId,
      });
      return { result, cost };
    },
    ({ result, cost }) => ({
      model: result.model,
      route: result.route,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      costUsd: cost?.costUsd ?? null,
      costBasis: cost?.basis ?? null,
    })
  );
  return result.text;
}

function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
}

function validateResearchSpec(raw: unknown): raw is ResearchSpec {
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
  // Counts are coerced post-validation (see coerceSpecCounts), so accept any
  // non-empty string array here instead of hard-rejecting on an off-by-N count.
  if (!Array.isArray(c.trust_signals) || c.trust_signals.length < 1) return false;
  if (!c.trust_signals.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(c.unique_selling_points) || c.unique_selling_points.length < 1) return false;
  if (!c.unique_selling_points.every((x) => typeof x === "string")) return false;
  const img = o.image_prompts;
  if (!img || typeof img !== "object") return false;
  const im = img as Record<string, unknown>;
  if (typeof im.hero !== "string" || typeof im.logo !== "string") return false;
  // catalog is rebuilt deterministically from the services in coerceSpecCounts,
  // and a shop with no services legitimately has none, so only the type matters.
  if (!Array.isArray(im.catalog)) return false;
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

/** Pad/truncate a string array to exactly `n` items, filling gaps via `fill`. */
function fitArray(arr: string[], n: number, fill: (i: number) => string): string[] {
  const out = arr.filter((x) => typeof x === "string" && x.trim()).slice(0, n);
  while (out.length < n) out.push(fill(out.length));
  return out;
}

/** Depict the shop's typical clientele so a barber shop shows men and a beauty
 *  parlor shows women — leaving the subject unspecified produced e.g. all-female
 *  service photos on a barber shop. "both" stays neutral (mixed clientele). */
function catalogSubjectFor(shopType: string): string {
  if (shopType === "barber_shop") return "a male client";
  if (shopType === "beauty_parlor") return "a female client";
  return "a client";
}

/**
 * Coerce the count-sensitive arrays to exactly what downstream expects, so a
 * model that returns e.g. 5 catalog prompts for 6 services (or 2 trust signals
 * instead of 3) yields a usable site instead of failing the whole job. The
 * image worker maps catalog[i] → services[i], so catalog must match 1:1.
 */
function coerceSpecCounts(
  spec: ResearchSpec,
  services: { name: string }[],
  shopType: string,
  business: ResearchBusiness,
): void {
  // Fillers come from the shop's own records, never from stock claims (the
  // old fillers asserted "Trusted by local clients" for every shop). The
  // assembler re-checks every item against the claims gate before publishing.
  const facts = factSignals(business, services.length, shopType);
  spec.content.trust_signals = fitArray(spec.content.trust_signals, 3, (i) => facts[i] ?? "Book online, any time");
  spec.content.unique_selling_points = fitArray(
    spec.content.unique_selling_points,
    3,
    (i) => ["Every price shown up front", "Pick your own team member", "Book online, any time"][i] ?? "Book online, any time"
  );
  spec.image_prompts.gallery = normalizeGalleryPrompts(spec.image_prompts.gallery, spec.layout_mood, shopType);
  // Catalog images map positionally: the images worker generates catalog[i]
  // from this prompt and the site renders it on services[i]. Both the catalog
  // build and the site's service list come from getServicesByShop (ORDER BY
  // category, name), so their order matches by construction. Build each prompt
  // DETERMINISTICALLY from its service instead of trusting the model's returned
  // catalog[] order: it is an unlabeled string[] we cannot realign, so a single
  // reordered or dropped entry would put the wrong style on the wrong card.
  // Barber/beauty service names are descriptive, so a name-based template reads
  // well; if brand-y names ("The Executive") ever make these too generic, the
  // upgrade path is a model-authored catalog KEYED BY service name (mapped back
  // by name) with a test — not an in-order string[].
  const subject = catalogSubjectFor(shopType);
  spec.image_prompts.catalog = services.map(
    (s) =>
      `Photorealistic close-up of the finished ${s?.name ?? "service"} result on ${subject}, flattering professional lighting, square format`
  );
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
    const category = typeof sv.category === "string" && sv.category.trim() ? sv.category.trim().slice(0, 40) : undefined;
    services.push({ name: sv.name, price_gbp: sv.price_gbp, duration_min: sv.duration_min, ...(category ? { category } : {}) });
  }
  // No minimum: a shop with no services yet gets a site without a menu. The
  // old two-service floor was met upstream by inventing placeholder services.
  const text_model =
    typeof o.text_model === "string" && o.text_model.trim() ? o.text_model.trim() : DEFAULT_TEXT_MODEL;
  const text_effort =
    o.text_effort === "low" || o.text_effort === "medium" || o.text_effort === "high"
      ? o.text_effort
      : undefined;
  const image_model =
    typeof o.image_model === "string" && o.image_model.trim() ? o.image_model.trim() : DEFAULT_IMAGE_MODEL;
  const skip_images = o.skip_images === true;
  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  const op = typeof o.color_primary === "string" && HEX6.test(o.color_primary.trim()) ? o.color_primary.trim() : undefined;
  const oa = typeof o.color_accent === "string" && HEX6.test(o.color_accent.trim()) ? o.color_accent.trim() : undefined;
  const hasColorOverride = Boolean(op && oa);
  const composer: ComposerId = parseComposer(o.composer) ?? "ai";
  const template =
    typeof o.template === "string" && o.template.trim() ? o.template.trim() : undefined;
  return {
    origin_actor_ref: originActorRef(o.origin_actor_ref),
    jobId: o.jobId,
    shopId: o.shopId,
    shopName: o.shopName,
    shopType: o.shopType,
    shopSlug: o.shopSlug,
    styleNotes: o.styleNotes,
    services,
    business: parseBusiness(o.business),
    hasLogoFile: o.hasLogoFile,
    text_model,
    ...(text_effort ? { text_effort } : {}),
    image_model,
    skip_images,
    ...(hasColorOverride ? { color_primary: op, color_accent: oa } : {}),
    composer,
    ...(template ? { template } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * End a job as failed with exactly one completion entry. Never throws: if the
 * entry cannot be written, fall back to the plain failed write (the job must
 * still end) and say so in the log. The KV mirror follows the terminal write,
 * and is skipped when another path had already finished the job.
 */
async function failJob(
  env: Env,
  rec: AuditRecorder,
  input: ResearchQueueMessage,
  error: string,
  reason: string
): Promise<void> {
  const { jobId, shopId } = input;
  try {
    let result: "finished" | "already_finished" = "finished";
    try {
      result = await finishJob(env.DB, rec, {
        jobId,
        shopId,
        status: "failed",
        stage: "research",
        error,
        reason,
        origin: input.origin_actor_ref ?? null,
      });
    } catch (auditErr) {
      console.error("[audit] job failed without its completion entry", jobId, auditErr);
      await updateGenerationJob(env.DB, jobId, { status: "failed", error });
    }
    if (result === "already_finished") return;
    await putJobKv(env.KV, jobId, { status: "failed", error, shopSlug: input.shopSlug });
  } catch (persistErr) {
    console.error("[pivot-parlor-research] Failed to persist job failure", persistErr);
  }
}

async function processOneMessage(body: unknown, env: Env): Promise<void> {
  const input = parseInput(body);
  if (!input) {
    console.error("[pivot-parlor-research] Invalid queue message shape", body);
    return;
  }

  const { jobId, shopId } = input;
  const origin = input.origin_actor_ref ?? null;
  const rec = queueAudit(env.DB, WORKER_NAME, jobId);
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    await failJob(env, rec, input, "OPENROUTER_API_KEY is not configured", "not_configured");
    return;
  }

  const keys: ProviderKeys = {
    openrouter: apiKey,
    openai: env.OPENAI_API_KEY || undefined,
    anthropic: env.ANTHROPIC_API_KEY || undefined,
  };

  try {
    console.log(`[${jobId}] [pivot-parlor-research] start shopSlug=${input.shopSlug}`);
    await updateGenerationJob(env.DB, jobId, { status: "running", stage: "research", error: null });
    await putJobKv(env.KV, jobId, { status: "running", stage: "research", shopSlug: input.shopSlug });

    const userPrompt = buildUserPrompt(input);
    console.log(`[${jobId}] [pivot-parlor-research] text model=${input.text_model}`);

    // HTTP retries (429/5xx, 3 s / 6 s / 9 s) and the effort retry live in the
    // shared client. This loop is for output validity (non-JSON, schema
    // failures): two tries of the chosen model, then rescue the job with the
    // default model on OpenRouter — a direct vendor with a missing key or an
    // outage must not sink the run.
    const attempts: { model: string; effort?: TextEffort }[] = [
      { model: input.text_model, effort: input.text_effort },
      { model: input.text_model, effort: input.text_effort },
      ...(input.text_model !== DEFAULT_TEXT_MODEL ? [{ model: DEFAULT_TEXT_MODEL }] : []),
    ];
    let spec: ResearchSpec | null = null;
    let lastError = "unknown";
    for (let i = 0; i < attempts.length; i++) {
      const { model, effort } = attempts[i]!;
      const attempt = i + 1;
      if (model !== input.text_model) {
        console.warn(
          `[${jobId}] [pivot-parlor-research] ${input.text_model} exhausted, falling back to default model ${model}`
        );
      }
      let rawText: string;
      try {
        rawText = await researchJson(jobId, keys, model, SYSTEM_PROMPT, userPrompt, effort, { env, shopId }, { rec, origin });
      } catch (e) {
        // A refused audit write ends the job; any other failure tries the next attempt.
        if (e instanceof AuditWriteError) throw e;
        lastError = `model call failed: ${errorMessage(e)}`;
        console.warn(`[${jobId}] [pivot-parlor-research] attempt ${attempt}/${attempts.length} ${lastError}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        lastError = "model returned non-JSON";
        console.warn(
          `[${jobId}] [pivot-parlor-research] attempt ${attempt}/${attempts.length} non-JSON len=${rawText.length} head=${JSON.stringify(rawText.slice(0, 200))}`
        );
        continue;
      }
      if (!validateResearchSpec(parsed)) {
        lastError = "model JSON failed schema validation";
        console.warn(
          `[${jobId}] [pivot-parlor-research] attempt ${attempt}/${attempts.length} schema-invalid head=${JSON.stringify(parsed).slice(0, 300)}`
        );
        continue;
      }
      spec = parsed;
      console.log(`[${jobId}] [pivot-parlor-research] valid spec on attempt ${attempt} (model=${model})`);
      break;
    }

    if (!spec) {
      const err = `Research worker could not produce a valid spec after ${attempts.length} attempts (${lastError})`;
      console.error(`[${jobId}] [pivot-parlor-research] ${err}`);
      await failJob(env, rec, input, err, "no_valid_spec");
      return;
    }

    coerceSpecCounts(spec, input.services, input.shopType, input.business);
    const serviceCopy = alignServiceCopy(spec.content.service_copy, input.services);
    // Honour an owner-chosen palette: overwrite the AI palette so the text
    // worker's research fallback and any spec consumer see the chosen colours.
    // The text worker re-applies the same override after its own copy pass,
    // which is what ultimately reaches the builder.
    if (input.color_primary && input.color_accent) {
      spec.palette.primary = input.color_primary;
      spec.palette.accent = input.color_accent;
    }
    // Honour an owner-chosen template the same way: the prompt asked the
    // model to comply, but the owner's pick must win even if it strayed.
    const pinnedMood = layoutMoodForTemplate(input.template);
    if (pinnedMood) spec.layout_mood = pinnedMood;
    // Curated typography (WS-6 item 5): the prompt pins the choices, this
    // post-force guarantees them — the web self-hosts exactly these families.
    spec.typography.heading_font = coerceCuratedFont(
      spec.typography.heading_font, "heading", spec.typography.heading_style
    );
    spec.typography.body_font = coerceCuratedFont(spec.typography.body_font, "body", "");
    const fullJson = JSON.stringify(spec);

    // Design Director (v3): seed spec is both the deterministic composer and
    // the fallback for invalid AI output. Per-field repair keeps generation
    // unfailable on a bad design_spec.
    const seedSpec = seedComposeDesignSpec(shopId, { template: input.template });
    let designSpec: DesignSpec;
    if (input.composer === "seed") {
      designSpec = seedSpec;
    } else {
      const normalized = normalizeDesignSpec(spec.design_spec, seedSpec);
      designSpec = normalized.spec;
      if (normalized.fellBack.length > 0) {
        console.warn(
          `[${jobId}] [pivot-parlor-research] design_spec fields fell back to seed: ${normalized.fellBack.join(", ")}`
        );
      }
    }

    const payload: GenResearchKvPayload = {
      spec,
      design_spec: designSpec,
      business: input.business,
      fact_signals: factSignals(input.business, input.services.length, input.shopType),
      service_copy: serviceCopy,
      style_notes: input.styleNotes.slice(0, 4000),
      origin_actor_ref: origin,
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
      ...(input.text_effort ? { text_effort: input.text_effort } : {}),
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
      const catalogUrls = urls(row?.catalog_images_json);
      const imagesPayload = {
        heroUrl: row?.hero_image_url?.trim() ?? "",
        logoUrl: row?.logo_url?.trim() ?? "",
        catalogUrls,
        galleryUrls: urls(row?.gallery_images_json),
        completedAt: new Date().toISOString(),
        errors: [] as { step: string; detail: string }[],
      };
      await env.KV.put(genImagesKey(jobId), JSON.stringify(imagesPayload), { expirationTtl: KV_TTL_SEC });
      await env.SITE_ASSEMBLE_QUEUE.send({
        jobId,
        shopId,
        shopSlug: input.shopSlug,
        origin_actor_ref: origin,
      });
      console.log(`[${jobId}] [pivot-parlor-research] skip_images: wrote ${genImagesKey(jobId)} + site-assemble-queue`);
    } else {
      await env.SITE_IMAGES_QUEUE.send({
        jobId,
        shopId,
        shopSlug: input.shopSlug,
        image_model: input.image_model,
        origin_actor_ref: origin,
      });
      console.log(`[${jobId}] [pivot-parlor-research] enqueued site-images-queue`);
    }

    await env.SITE_TEXT_QUEUE.send({
      jobId,
      shopId,
      shopSlug: input.shopSlug,
      text_model: input.text_model,
      ...(input.text_effort ? { text_effort: input.text_effort } : {}),
      origin_actor_ref: origin,
    });
    console.log(`[${jobId}] [pivot-parlor-research] enqueued site-text-queue`);
  } catch (err) {
    console.error(`[${jobId}] [pivot-parlor-research] Job failed`, err);
    if (err instanceof AuditWriteError) {
      await failJob(env, rec, input, "Could not record this action; nothing was changed.", "audit_refused");
    } else {
      await failJob(env, rec, input, errorMessage(err), "crash");
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
