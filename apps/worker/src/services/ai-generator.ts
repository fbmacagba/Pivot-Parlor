import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { effortFor, getModel, type TextEffort } from "./model-registry.js";
import { billedUsageOf, chatComplete, recordAiUsage, type ChatUsage, type ProviderKeys } from "@repo/llm";
import { AuditWriteError, type AuditRecorder } from "@repo/audit";
import { safeJsonParse } from "@repo/utils";
import { WORKER_NAME } from "../audit/context.js";

// ─── Brand config (full schema, with conversion-optimised copy fields) ────────

export interface BrandConfig {
  primaryColor: string;
  accentColor: string;
  fontHeading: string;
  fontBody: string;
  tagline: string;
  heroHeadline: string;
  heroSubheadline: string;
  shortDescription: string;
  ctaText: string;
  aestheticKeywords: string[];
  servicesIntro: string;
  trustStatement: string;
  urgencyText: string;
}

const THEME_KV_TTL = 60 * 60 * 24 * 30; // 30 days

export interface ThemePalette {
  primary: string;
  accent: string;
}

export interface ThemeGenerationOptions {
  /** Owner-chosen palette — wins over the model's colour pick. */
  palette?: ThemePalette;
  /** Write the result to D1/KV (default true). Previews pass false. */
  persist?: boolean;
  /** When set, the vendor call and the persisted theme are audited. */
  audit?: AuditRecorder;
  /**
   * The request id `audit` records under (`c.get("requestId")`). With `audit`,
   * each billed model call also gets a cost-log row under it, which is how
   * the historical import pairs that row with its live ai.call. Never set
   * without `audit`: a row with no live twin would later import as a false
   * "historical" entry.
   */
  costLogJobId?: string;
}

/** Where an audited theme call's cost-log row goes. */
interface ThemeCostLog {
  db: D1Database;
  kv: KVNamespace;
  shopId: string;
  jobId: string;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  shopName: string,
  shopType: string,
  styleKeywords?: string,
  palette?: ThemePalette
): string {
  const shopTypeLabel = shopType.replace(/_/g, " ");
  return `You are an expert brand strategist and direct response copywriter specialising in beauty and grooming businesses.

Generate a high-converting brand config for a ${shopTypeLabel} called "${shopName}".
${styleKeywords ? `Style preferences: ${styleKeywords}` : ""}
${palette ? `The owner has locked the colour palette: primaryColor MUST be ${palette.primary} and accentColor MUST be ${palette.accent}. Choose fonts and write copy that harmonise with those colours.` : ""}

Your output must maximise bookings and conversion using these proven frameworks:
- AIDA (Attention, Interest, Desire, Action) for copy structure
- PAS (Problem, Agitate, Solution) for the hero subheadline
- Social proof and urgency triggers baked into the copy
- Benefit-led language (not feature-led)
- Emotional resonance — customers book when they feel understood

Return ONLY valid JSON with exactly these keys (no markdown, no explanation):
{
  "primaryColor": "hex colour — dark, premium feel (e.g. #1A1A1A, #1B2B3A, #0D1F0D)",
  "accentColor": "hex colour — warm, inviting accent (e.g. #C9A84C, #D4956A, #9B6B9B)",
  "fontHeading": "Google Font name — premium, characterful (e.g. Playfair Display, Cormorant Garamond, DM Serif Display)",
  "fontBody": "Google Font name — clean, readable (e.g. DM Sans, Inter, Nunito)",
  "tagline": "5-8 words. Benefit-led. E.g. Where every visit builds your confidence",
  "heroHeadline": "4-7 words. Bold, attention-grabbing. E.g. Your best look starts here",
  "heroSubheadline": "1-2 sentences using PAS — identify the problem, agitate it, position the shop as the solution",
  "shortDescription": "2-3 sentences. Benefit-led description of the shop for the about section",
  "ctaText": "3-5 words for the main booking button. Action-oriented. E.g. Book your session now",
  "aestheticKeywords": ["3-5 keywords describing the visual style"],
  "servicesIntro": "1 sentence introducing the services section. Focus on transformation, not just services",
  "trustStatement": "1 sentence building trust. E.g. mention experience, satisfied clients, or guarantee",
  "urgencyText": "Short urgency/scarcity line. E.g. Limited slots available this week — book before they fill up"
}`;
}

// ─── Default fallback theme ───────────────────────────────────────────────────

function defaultTheme(shopName: string, shopType: string): BrandConfig {
  const label = shopType.replace(/_/g, " ");
  return {
    primaryColor: "#1a1a2e",
    accentColor: "#c9a84c",
    fontHeading: "Playfair Display",
    fontBody: "DM Sans",
    tagline: `Premium ${label} experience`,
    heroHeadline: `Welcome to ${shopName}`,
    heroSubheadline: `Finding the right ${label} shouldn't be stressful. At ${shopName}, expert stylists and a seamless booking experience await you.`,
    shortDescription: `${shopName} delivers exceptional ${label} services in a welcoming environment. Our skilled team is dedicated to making you look and feel your best.`,
    ctaText: "Book your appointment",
    aestheticKeywords: ["luxury", "professional", "modern", "welcoming"],
    servicesIntro: "Discover treatments designed to enhance your natural best",
    trustStatement: `Trusted by hundreds of satisfied clients across London`,
    urgencyText: "Limited slots this week. Secure your spot today",
  };
}

// ─── Model caller (OpenRouter, OpenAI API or Anthropic API by id prefix) ─────

/** Reasoning tokens count against the completion budget on every route, so
 *  give thinking models room to reason AND still emit the full JSON. Pass the
 *  level that will actually run: the chosen one, else the model's reported
 *  default. With neither known, budget for "high" (Claude, Grok and DeepSeek
 *  default to it and GLM to max); the old 1024 could be spent on thinking
 *  alone. A ceiling, not a charge: only generated tokens are billed.
 *  Estimated from the vendors' docs, not measured. */
export function maxTokensForEffort(effort: TextEffort | undefined): number {
  switch (effort) {
    case "none":
    case "minimal":
    case "low":
      return 2048;
    case "medium":
      return 4096;
    case "xhigh":
      return 12_288;
    case "max":
      return 16_000;
    default:
      return 8192;
  }
}

/** estimated_cost_usd is permanent (details_json); round rather than carry
 *  floating-point noise into a hashed, 6-year-locked column. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

const THEME_SYSTEM_PROMPT =
  "You are a brand designer and direct response copywriter. Return ONLY valid JSON, no markdown, no explanation, no code fences.";

/** One cost-log row for a billed theme call. Never throws (recordAiUsage logs instead). */
async function recordThemeUsage(costLog: ThemeCostLog, modelId: string, usage: ChatUsage | null): Promise<void> {
  await recordAiUsage(
    { DB: costLog.db, KV: costLog.kv },
    { shopId: costLog.shopId, workerName: WORKER_NAME, modelId, usageType: "theme", usage, jobId: costLog.jobId }
  );
}

async function callThemeModel(
  modelId: string,
  prompt: string,
  keys: ProviderKeys,
  effort: TextEffort | undefined,
  /** The level that will run (effort, else the model's default): sizes the budget. */
  budgetEffort: TextEffort | undefined,
  /** Set when the call is audited: where its cost-log row goes. */
  costLog: ThemeCostLog | null
): Promise<{ config: BrandConfig; route: string; model: string; inputTokens: number | null; outputTokens: number | null }> {
  let result: Awaited<ReturnType<typeof chatComplete>>;
  try {
    // A developer is waiting on this request: one retry, not three.
    result = await chatComplete(
      {
        modelId,
        system: THEME_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        effort,
        maxTokens: maxTokensForEffort(budgetEffort),
        jsonOnly: true,
        maxRetries: 1,
        appTitle: "Pivot Parlor",
      },
      keys
    );
  } catch (err) {
    // An empty reply (a reasoning model that spent its budget thinking) was
    // still billed: log its tokens before the attempt fails.
    const billed = billedUsageOf(err);
    if (billed && costLog) await recordThemeUsage(costLog, modelId, billed);
    throw err;
  }
  console.log(
    `[AI Generator] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
  );
  // Before parsing: a reply that is not valid JSON was billed all the same.
  if (costLog) await recordThemeUsage(costLog, modelId, result.usage);
  return {
    config: JSON.parse(result.text) as BrandConfig,
    route: result.route,
    model: result.model,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
  };
}

// ─── Main generator ───────────────────────────────────────────────────────────

export interface ThemeAudit {
  recorder: AuditRecorder;
  /** null when the caller cannot know (e.g. /apply-theme persisting a
   *  client-supplied preview whose own generation this server never saw). */
  fallback: boolean | null;
}

// heroHeadline and tagline are excluded (Ruling 20): generated copy routinely
// contains the shop name (personal data, Ruling 17) and, via /apply-theme, is
// unbounded client text (Ruling 14) — and changes_json/details_json are
// hashed and locked for 6 years, never blanked. `copy_changed` below records
// only WHETHER that copy changed, never the words.
const THEME_AUDIT_KEYS = ["primaryColor", "accentColor", "fontHeading", "fontBody"] as const;

/** Per-field log-side shape gates (Ruling 20/21): a field is logged only when
 *  it looks like what it claims to be, else `null`, checked independently on
 *  the before AND after value. Log-side only — business validation
 *  (`validateBrandConfig`) is untouched, and the /generate-theme path never
 *  runs it at all, so a model's raw JSON output needs the same gate here. */
const THEME_LOG_SHAPE: Record<(typeof THEME_AUDIT_KEYS)[number], RegExp> = {
  primaryColor: /^#[0-9A-Fa-f]{3,8}$/,
  accentColor: /^#[0-9A-Fa-f]{3,8}$/,
  fontHeading: /^[A-Za-z0-9 ,'"-]{1,64}$/,
  fontBody: /^[A-Za-z0-9 ,'"-]{1,64}$/,
};

function loggableIfShaped(value: string | undefined, shape: RegExp): string | null {
  return typeof value === "string" && shape.test(value) ? value : null;
}

/** Write a theme to the shop row and the KV cache — the single "apply" path.
 *  With `audit`, the row update and its theme.apply entry commit together. */
export async function persistShopTheme(
  db: D1Database,
  kv: KVNamespace,
  shopId: string,
  modelId: string,
  config: BrandConfig,
  audit?: ThemeAudit
): Promise<void> {
  const update = db
    .prepare("UPDATE shops SET ai_theme = ?, ai_model = ? WHERE id = ?")
    .bind(JSON.stringify(config), modelId, shopId);

  if (audit) {
    const prev = await db
      .prepare("SELECT ai_theme, ai_model FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_theme: string | null; ai_model: string | null }>();
    const before = (safeJsonParse(prev?.ai_theme ?? null) ?? {}) as Partial<BrandConfig>;
    const changes: Record<string, [unknown, unknown]> = { ai_model: [prev?.ai_model ?? null, modelId] };
    for (const k of THEME_AUDIT_KEYS) {
      const shape = THEME_LOG_SHAPE[k];
      changes[k] = [loggableIfShaped(before[k], shape), loggableIfShaped(config[k], shape)];
    }
    const copyChanged = before.heroHeadline !== config.heroHeadline || before.tagline !== config.tagline;
    // Commits the row update and the audit entry in ONE batch (Plan ruling 8):
    // `statements()` alone never flips the gap guard's `auditWritten` flag, so
    // batching through the recorder is required for the guard to see this as
    // a committed write, not a false gap.
    await audit.recorder.batch([update], {
      action: "theme.apply",
      outcome: "succeeded",
      shopId,
      entityType: "theme",
      entityId: shopId,
      changes,
      details: { model: modelId, fallback: audit.fallback, copy_changed: copyChanged },
    });
  } else {
    await update.run();
  }

  await kv.put(`shop:theme:${shopId}`, JSON.stringify(config), {
    expirationTtl: THEME_KV_TTL,
  });
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Validate an externally supplied theme (the apply endpoint) — returns null on junk. */
export function validateBrandConfig(raw: unknown): BrandConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const strings = [
    "fontHeading",
    "fontBody",
    "tagline",
    "heroHeadline",
    "heroSubheadline",
    "shortDescription",
    "ctaText",
    "servicesIntro",
    "trustStatement",
    "urgencyText",
  ] as const;
  for (const key of strings) {
    if (typeof o[key] !== "string" || !(o[key] as string).trim()) return null;
  }
  if (typeof o.primaryColor !== "string" || !HEX6.test(o.primaryColor.trim())) return null;
  if (typeof o.accentColor !== "string" || !HEX6.test(o.accentColor.trim())) return null;
  if (!Array.isArray(o.aestheticKeywords) || !o.aestheticKeywords.every((k) => typeof k === "string")) {
    return null;
  }
  return {
    primaryColor: o.primaryColor.trim(),
    accentColor: o.accentColor.trim(),
    fontHeading: o.fontHeading as string,
    fontBody: o.fontBody as string,
    tagline: o.tagline as string,
    heroHeadline: o.heroHeadline as string,
    heroSubheadline: o.heroSubheadline as string,
    shortDescription: o.shortDescription as string,
    ctaText: o.ctaText as string,
    aestheticKeywords: o.aestheticKeywords as string[],
    servicesIntro: o.servicesIntro as string,
    trustStatement: o.trustStatement as string,
    urgencyText: o.urgencyText as string,
  };
}

export async function generateShopTheme(
  shopId: string,
  shopName: string,
  shopType: string,
  modelId: string,
  styleKeywords: string | undefined,
  effort: TextEffort | undefined,
  db: D1Database,
  kv: KVNamespace,
  keys: ProviderKeys,
  options: ThemeGenerationOptions = {}
): Promise<BrandConfig> {
  const model = await getModel(kv, keys, modelId, "text");
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  const prompt = buildPrompt(shopName, shopType, styleKeywords, options.palette);

  let config: BrandConfig;
  let fallback = false;
  // Only forward a level the model accepts: vendors reject others, and the
  // one-shot retry without effort would then run the default while the
  // request said otherwise.
  const { effort: effectiveEffort, dropped } = effortFor(model, effort);
  if (dropped) console.warn(`[AI Generator] ${modelId} does not take effort ${dropped}; using the model's default`);
  const budgetEffort = effectiveEffort ?? model.defaultEffort ?? undefined;
  // Only an audited call is cost-logged: its row needs a live ai.call twin.
  const costLog = options.audit && options.costLogJobId ? { db, kv, shopId, jobId: options.costLogJobId } : null;
  const call = () => callThemeModel(modelId, prompt, keys, effectiveEffort, budgetEffort, costLog);
  try {
    const result = options.audit
      ? await options.audit.run(
          { action: "ai.call", shopId, entityType: "shop", entityId: shopId, details: { purpose: "theme", model: modelId } },
          call,
          (r) => ({
            details: {
              purpose: "theme",
              model: r.model,
              route: r.route,
              input_tokens: r.inputTokens,
              output_tokens: r.outputTokens,
              estimated_cost_usd:
                r.inputTokens !== null && r.outputTokens !== null && (model.costPer1MInput !== 0 || model.costPer1MOutput !== 0)
                  ? round6((r.inputTokens * model.costPer1MInput + r.outputTokens * model.costPer1MOutput) / 1_000_000)
                  : null,
            },
          })
        )
      : await call();
    config = result.config;
  } catch (err) {
    if (err instanceof AuditWriteError) throw err;
    console.error(`[AI Generator] ${model.provider} call failed, using fallback:`, err);
    config = defaultTheme(shopName, shopType);
    fallback = true;
  }

  // An owner-chosen palette must win over the model's colour pick.
  if (options.palette) {
    config.primaryColor = options.palette.primary;
    config.accentColor = options.palette.accent;
  }

  if (options.persist !== false) {
    await persistShopTheme(db, kv, shopId, modelId, config, options.audit ? { recorder: options.audit, fallback } : undefined);
  }

  return config;
}
