/**
 * pivot-parlor-text — Consumes site-text-queue: OpenRouter copy → KV gen:{jobId}:text → site-assemble-queue.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";
import { chatComplete, recordAiUsage, type ProviderKeys, type UsageCost } from "@repo/llm";
import {
  AuditWriteError,
  auditAiCall,
  finishJob,
  originActorRef,
  queueAudit,
  type AuditRecorder,
} from "@repo/audit";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITE_ASSEMBLE_QUEUE: Queue;
  OPENROUTER_API_KEY: string;
  /** Direct-vendor keys; optional. A chosen direct model with no key falls back to the default model. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENVIRONMENT: string;
}

/** Reasoning-effort level for models that support it (OpenRouter `reasoning`). */
export type TextEffort = "low" | "medium" | "high";

export interface StageMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
  text_model?: string;
  text_effort?: TextEffort;
  /** Who clicked Regenerate (`subj_user_<id>`). Absent on messages from before the audit trail. */
  origin_actor_ref?: string | null;
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
  text_effort?: TextEffort;
  image_model?: string;
  /** Owner-chosen palette override (6-digit hex pair) — wins over the AI palette. */
  owner_color_primary?: string;
  owner_color_accent?: string;
  /** Research's per-service description, keyed by the real service name. */
  service_copy?: Record<string, string>;
  /** Owner-entered facts block (team, hours, area); absent on older payloads. */
  business?: unknown;
  /** Who clicked Regenerate; research writes it, absent on older payloads. */
  origin_actor_ref?: string | null;
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

const WORKER_NAME = "pivot-parlor-text";
const AUDIT_REFUSED_ERROR = "Could not record this action; nothing was changed.";
const DEFAULT_TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
const KV_TTL_SEC = 3600;

const genResearchKey = (jobId: string) => `gen:${jobId}:research`;
const genTextKey = (jobId: string) => `gen:${jobId}:text`;

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function parseStageMessage(body: unknown): StageMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string" || typeof o.shopSlug !== "string") return null;
  const text_model =
    typeof o.text_model === "string" && o.text_model.trim() ? o.text_model.trim() : undefined;
  const text_effort =
    o.text_effort === "low" || o.text_effort === "medium" || o.text_effort === "high"
      ? o.text_effort
      : undefined;
  return {
    jobId: o.jobId,
    shopId: o.shopId,
    shopSlug: o.shopSlug,
    text_model,
    text_effort,
    origin_actor_ref: originActorRef(o.origin_actor_ref),
  };
}

/** One JSON-only completion through the shared client (HTTP retries and the
 *  effort retry live there). Every answered call is written to the cost log,
 *  valid output or not: the tokens were spent either way. */
async function textJson(
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
  // reuses the cost just recorded. A refused started write throws
  // AuditWriteError before the model is called.
  const { result } = await auditAiCall(
    audit.rec,
    { purpose: "site_text", model, shopId: costLog.shopId, origin: audit.origin },
    async () => {
      const result = await chatComplete(
        {
          modelId: model,
          system,
          messages: [{ role: "user", content: user }],
          effort,
          maxTokens: 8000,
          jsonOnly: true,
          appTitle: "Pivot Parlor Text",
        },
        keys
      );
      console.log(
        `[${jobId}] [pivot-parlor-text] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
      );
      const cost: UsageCost | null = await recordAiUsage(costLog.env, {
        shopId: costLog.shopId,
        workerName: WORKER_NAME,
        modelId: model,
        usageType: "site_text",
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
  // Model services only contribute descriptions (see servicesFromSource); the
  // shape check stays tolerant so one malformed entry cannot sink the copy.
  if (o.services !== undefined && !Array.isArray(o.services)) return false;
  return true;
}

const normName = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The published menu is the shop's REAL services: names, prices and durations
 * come from the source list (the services table), in source order, so the
 * site, the booking flow and the catalog images always agree. The model may
 * only supply a description, matched by name; research's per-service copy is
 * the fallback; otherwise the description is left empty rather than invented.
 * (This replaced an instruction to "invent exactly 3 plausible services" and a
 * pad to two "Default service" rows at £25.)
 */
export function servicesFromSource(
  research: Pick<GenResearchKvPayload, "services" | "service_copy" | "spec">,
  modelServices: unknown,
): TextServiceOut[] {
  const modelDesc = new Map<string, string>();
  if (Array.isArray(modelServices)) {
    for (const s of modelServices) {
      if (!s || typeof s !== "object") continue;
      const { name, description } = s as { name?: unknown; description?: unknown };
      if (typeof name === "string" && typeof description === "string" && description.trim()) {
        modelDesc.set(normName(name), description.trim().slice(0, 280));
      }
    }
  }
  const copy = new Map<string, string>();
  for (const [k, v] of Object.entries(research.service_copy ?? {})) {
    if (typeof v === "string" && v.trim()) copy.set(normName(k), v.trim());
  }
  const catalog = (research.spec.image_prompts as { catalog?: unknown } | undefined)?.catalog;
  return research.services.map((s, i) => ({
    name: s.name,
    price_gbp: s.price_gbp,
    duration_minutes: s.duration_min,
    description: modelDesc.get(normName(s.name)) ?? copy.get(normName(s.name)) ?? "",
    image_prompt: Array.isArray(catalog) && typeof catalog[i] === "string" ? (catalog[i] as string) : "",
  }));
}

export function fallbackFromResearch(research: GenResearchKvPayload): TextKvPayload {
  const spec = research.spec;
  const content = spec.content as Record<string, unknown> | undefined;
  const palette = spec.palette as Record<string, unknown> | undefined;
  const typo = spec.typography as Record<string, unknown> | undefined;
  const services = servicesFromSource(research, undefined);
  return {
    headline: typeof content?.headline === "string" ? content.headline : research.shopName,
    tagline: typeof content?.subheadline === "string" ? content.subheadline : "Book your appointment online",
    about:
      typeof content?.about_body === "string"
        ? content.about_body
        : `Welcome to ${research.shopName}. We look forward to seeing you.`,
    services,
    seo_title: typeof content?.seo_title === "string" ? content.seo_title : `${research.shopName} | Book online`,
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
  const rec = queueAudit(env.DB, WORKER_NAME, jobId);

  const researchRaw = await env.KV.get(genResearchKey(jobId));
  let research: GenResearchKvPayload | null = null;
  try {
    research = researchRaw ? (JSON.parse(researchRaw) as GenResearchKvPayload) : null;
  } catch {
    research = null;
  }
  if (!research) {
    // Nothing to write copy from: fail the job now instead of leaving the
    // assembler to poll for text for 20 minutes. The published site is untouched.
    const err = `text: research output ${researchRaw ? "unreadable" : "missing"} (gen:${jobId}:research)`;
    console.error(`[${jobId}] [pivot-parlor-text] ${err}`);
    await failJob(env, rec, { jobId, shopId: msg.shopId, origin: msg.origin_actor_ref ?? null }, err, "missing_research");
    return;
  }
  // Who clicked Regenerate: the message first, then the copy research kept.
  const origin = msg.origin_actor_ref ?? originActorRef(research.origin_actor_ref);

  const apiKey = env.OPENROUTER_API_KEY;
  const keys: ProviderKeys = {
    openrouter: apiKey,
    openai: env.OPENAI_API_KEY || undefined,
    anthropic: env.ANTHROPIC_API_KEY || undefined,
  };

  const servicesJson = JSON.stringify(research.services);
  const specJson = JSON.stringify(research.spec).slice(0, 12000);
  const businessJson = JSON.stringify(research.business ?? {}).slice(0, 2000);

  const system = `You output JSON only for a barber/beauty shop website. Obey word limits exactly. Colours must be 6-digit hex like #1a2b3c. State only facts you are given: never invent client counts, ratings, reviews, awards, rankings, years in business, qualifications, guarantees or testimonials.`;

  const user = `Shop name: ${research.shopName}
Shop type: ${research.shopType}
Owner-entered facts (the only business facts you may state): ${businessJson}
Research spec (for style; do not copy long legal text): ${specJson}

The shop's real services (name, price_gbp, duration_min). They are fixed: do not add, remove, rename or reprice any.
${servicesJson}

Return JSON:
{
  "headline": string (max 10 words, specific to this shop, no superlatives),
  "tagline": string (max 20 words),
  "about": string (3-4 sentences, warm owner voice, grounded in the facts and style notes),
  "services": [{ "name": string (exact name from the list), "description": string (one or two plain sentences, max 30 words, what the appointment involves and who it suits; no prices, no claims) }] (one entry per real service; empty array when there are none),
  "seo_title": string (max 60 chars),
  "seo_description": string (max 155 chars),
  "color_primary": string (hex),
  "color_accent": string (hex),
  "font_heading": string (Google Font),
  "font_body": string (Google Font)
}`;

  const textModel = msg.text_model?.trim() || research.text_model?.trim() || DEFAULT_TEXT_MODEL;
  const textEffort = msg.text_effort ?? research.text_effort;
  console.log(
    `[${jobId}] [pivot-parlor-text] calling model=${textModel}${textEffort ? ` effort=${textEffort}` : ""}`
  );

  // Chosen model first; if it fails outright (missing direct key, outage)
  // rescue with the default model on OpenRouter before settling for the
  // research-derived copy.
  // No key: skip the model and publish research's own copy (still generated
  // for this shop) rather than leaving the job waiting on text.
  const attempts: { model: string; effort?: TextEffort }[] = !apiKey
    ? []
    : [
        { model: textModel, effort: textEffort },
        ...(textModel !== DEFAULT_TEXT_MODEL ? [{ model: DEFAULT_TEXT_MODEL }] : []),
      ];
  if (!apiKey) console.error(`[${jobId}] [pivot-parlor-text] OPENROUTER_API_KEY missing; using research copy`);

  let payload: TextKvPayload | null = null;
  for (const { model, effort } of attempts) {
    if (model !== textModel) {
      console.warn(`[${jobId}] [pivot-parlor-text] ${textModel} failed, falling back to default model ${model}`);
    }
    try {
      const raw = await textJson(jobId, keys, model, system, user, effort, { env, shopId: msg.shopId }, { rec, origin });
      const parsed: unknown = JSON.parse(raw);
      if (validateTextOut(parsed)) {
        parsed.services = servicesFromSource(research, parsed.services);
        parsed.completedAt = new Date().toISOString();
        payload = parsed;
      } else {
        console.warn(`[${jobId}] [pivot-parlor-text] model output invalid (model=${model})`);
      }
      break; // a reply came back; an invalid one is not retried on another model
    } catch (e) {
      // A refused audit write ends the job; any other failure tries the next model.
      if (e instanceof AuditWriteError) throw e;
      console.error(`[${jobId}] [pivot-parlor-text] model call failed (model=${model})`, e);
    }
  }
  if (!payload) {
    console.warn(`[${jobId}] [pivot-parlor-text] using research fallback copy`);
    payload = fallbackFromResearch(research);
  }

  // An owner-chosen palette must win over the model's colour pick (which is
  // generated fresh on both the success and fallback paths). Apply it last.
  if (HEX6.test(research.owner_color_primary ?? "") && HEX6.test(research.owner_color_accent ?? "")) {
    payload.color_primary = research.owner_color_primary!;
    payload.color_accent = research.owner_color_accent!;
    console.log(`[${jobId}] [pivot-parlor-text] applied owner palette override`);
  }

  await env.KV.put(genTextKey(jobId), JSON.stringify(payload), { expirationTtl: KV_TTL_SEC });
  console.log(
    `[${jobId}] [pivot-parlor-text] wrote KV ${genTextKey(jobId)} services=${payload.services.length} headline="${payload.headline.slice(0, 40)}..."`
  );

  await env.SITE_ASSEMBLE_QUEUE.send({ jobId: msg.jobId, shopId: msg.shopId, shopSlug: msg.shopSlug, origin_actor_ref: origin });
  console.log(`[${jobId}] [pivot-parlor-text] enqueued site-assemble-queue`);
}

/**
 * An unexpected error must end the job now. Nothing else writes the text KV,
 * and the assembler (already enqueued by research and images) would keep
 * polling for it: 20 retries, 60 s apart. Once D1 says failed, the assembler
 * exits on its next attempt and the published site is untouched.
 */
export async function failJobAfterCrash(env: Pick<Env, "DB">, body: unknown, e: unknown): Promise<void> {
  const raw = (body ?? {}) as { jobId?: unknown; shopId?: unknown; origin_actor_ref?: unknown };
  const jobId = raw.jobId;
  if (typeof jobId !== "string" || !jobId) return;
  const refused = e instanceof AuditWriteError;
  const error = refused ? AUDIT_REFUSED_ERROR : `text: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  const shopId = raw.shopId;
  if (typeof shopId !== "string" || !shopId) {
    console.error("[audit] job failed without its completion entry", jobId);
    await legacyFailedWrite(env, jobId, error);
    return;
  }
  await failJob(
    env,
    queueAudit(env.DB, WORKER_NAME, jobId),
    { jobId, shopId, origin: originActorRef(raw.origin_actor_ref) },
    error,
    refused ? "audit_refused" : "crash"
  );
}

/**
 * End a job as failed with exactly one completion entry. Never throws: if the
 * entry cannot be written, fall back to the plain guarded failed write (the job
 * must still end) and say so in the log.
 */
async function failJob(
  env: Pick<Env, "DB">,
  rec: AuditRecorder,
  job: { jobId: string; shopId: string; origin: string | null },
  error: string,
  reason: string
): Promise<void> {
  try {
    await finishJob(env.DB, rec, { ...job, status: "failed", stage: "text", error, reason });
  } catch (auditErr) {
    console.error("[audit] job failed without its completion entry", job.jobId, auditErr);
    await legacyFailedWrite(env, job.jobId, error);
  }
}

async function legacyFailedWrite(env: Pick<Env, "DB">, jobId: string, error: string): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE generation_jobs SET status = 'failed', stage = 'text', error = ?, updated_at = ? WHERE id = ? AND status NOT IN ('complete', 'failed')"
    )
      .bind(error, new Date().toISOString(), jobId)
      .run();
  } catch (persistErr) {
    console.error(`[${jobId}] [pivot-parlor-text] could not record the failure`, persistErr);
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await processOne(m.body, env);
      } catch (e) {
        console.error("[pivot-parlor-text] outer failure", e);
        await failJobAfterCrash(env, m.body, e);
      } finally {
        m.ack();
      }
    }
  },
};
