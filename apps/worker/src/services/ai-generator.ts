import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { getModel, type TextEffort } from "./model-registry.js";
import { chatComplete, type ProviderKeys } from "@repo/llm";
import type { AuditRecorder } from "@repo/audit";
import { safeJsonParse } from "@repo/utils";

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
    urgencyText: "Limited slots this week — secure your spot today",
  };
}

// ─── Model caller (OpenRouter, OpenAI API or Anthropic API by id prefix) ─────

/** Reasoning tokens count against the completion budget on most providers, so
 *  give thinking models room to reason AND still emit the full JSON. */
function maxTokensForEffort(effort: TextEffort | undefined): number {
  if (effort === "high") return 8192;
  if (effort === "medium") return 4096;
  if (effort === "low") return 2048;
  return 1024;
}

const THEME_SYSTEM_PROMPT =
  "You are a brand designer and direct response copywriter. Return ONLY valid JSON, no markdown, no explanation, no code fences.";

async function callThemeModel(
  modelId: string,
  prompt: string,
  keys: ProviderKeys,
  effort?: TextEffort
): Promise<{ config: BrandConfig; route: string; model: string; inputTokens: number | null; outputTokens: number | null }> {
  // A developer is waiting on this request: one retry, not three.
  const result = await chatComplete(
    {
      modelId,
      system: THEME_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      effort,
      maxTokens: maxTokensForEffort(effort),
      jsonOnly: true,
      maxRetries: 1,
      appTitle: "Pivot Parlor",
    },
    keys
  );
  console.log(
    `[AI Generator] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
  );
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

const THEME_AUDIT_KEYS = ["primaryColor", "accentColor", "fontHeading", "fontBody", "heroHeadline", "tagline"] as const;

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
    for (const k of THEME_AUDIT_KEYS) changes[k] = [before[k] ?? null, config[k] ?? null];
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
      details: { model: modelId, fallback: audit.fallback },
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
  // Only forward effort to models that accept it — OpenRouter rejects the
  // reasoning parameter on some non-reasoning providers.
  const effectiveEffort = model.supportsEffort ? effort : undefined;
  const call = () => callThemeModel(modelId, prompt, keys, effectiveEffort);
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
                r.inputTokens !== null && r.outputTokens !== null
                  ? (r.inputTokens * model.costPer1MInput + r.outputTokens * model.costPer1MOutput) / 1_000_000
                  : null,
            },
          })
        )
      : await call();
    config = result.config;
  } catch (err) {
    if (err instanceof Error && err.name === "AuditWriteError") throw err;
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
