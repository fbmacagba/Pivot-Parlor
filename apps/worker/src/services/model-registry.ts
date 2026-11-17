/**
 * Live model registry for the developer AI tools.
 *
 * Three text groups (OpenRouter, OpenAI API, Anthropic API) plus the curated
 * OpenRouter image group. Each vendor list is fetched live and ranked by rule
 * (spec 2026-09-12 section 3.2), every entry is priced from OpenRouter's public
 * feed (direct ids through their OpenRouter twin), and the result is cached in
 * KV for an hour. Per group, a failed fetch keeps the group from the last good
 * build; with none, the snapshot in @repo/utils is used. A missing platform
 * key hides that direct group.
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import type { AIModel, TextEffort } from "@repo/types";
import {
  catalogModels,
  fallbackPriceFor,
  ROUTE_LABELS,
  VENDOR_ORDER,
  vendorLabel,
  DEFAULT_TEXT_MODEL_ID,
  type ModelKind,
  type ModelRoute,
} from "@repo/utils";
import {
  MODELS_KV_KEY,
  MODELS_LAST_GOOD_KV_KEY,
  orderEfforts,
  parseEffort,
  parseModelId,
  priceTwin,
  type ProviderKeys,
} from "@repo/llm";

export type { TextEffort };

/** Default model for the theme generator (site pipeline default lives in shops.ts). */
export const DEFAULT_THEME_MODEL = "anthropic/claude-sonnet-5.5";

/**
 * KV keys for the served list. MODELS_LAST_GOOD_KV_KEY is the last successful
 * build, with no expiry: the per-group fallback when a vendor fetch fails.
 * Defined in @repo/llm because the research and text workers read the same
 * list to price their calls for the cost log.
 */
export { MODELS_KV_KEY, MODELS_LAST_GOOD_KV_KEY };
export const MODELS_KV_TTL = 3600; // 1h — pricing moves slowly; avoids hammering three catalogues
export const DEGRADED_KV_TTL = 60; // feed down: retry soon, but not on every request
const FETCH_TIMEOUT_MS = 10_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
/** Offered when a source says a model reasons but not at which levels (the pre-2026-11 rule). */
const CLASSIC_EFFORTS: TextEffort[] = ["low", "medium", "high"];
/** The levels Anthropic's Messages API takes; it has no "none" or "minimal". */
const ANTHROPIC_API_EFFORTS: TextEffort[] = ["low", "medium", "high", "xhigh", "max"];
/** A vendor whose newest pick is this much older than its newest model gets a drift warning. */
const DRIFT_GRACE_S = 7 * 24 * 3600;
/** OpenRouter ids that stay listed even when the ranking would drop them. */
const PINNED_OPENROUTER_TEXT_IDS = [DEFAULT_TEXT_MODEL_ID, DEFAULT_THEME_MODEL];

export interface OpenRouterFeedModel {
  id: string;
  name?: string;
  /** Unix seconds when OpenRouter added the model. */
  created?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
  /** Present on reasoning models: the levels accepted and the one used when none is sent. */
  reasoning?: { mandatory?: boolean; supported_efforts?: string[]; default_effort?: string } | null;
  /** Set when the model is scheduled to leave OpenRouter. */
  expiration_date?: string | null;
}

type CapabilitySupport = { supported?: boolean } | null | undefined;

/** One entry of Anthropic's `GET /v1/models` (shape per the Models API reference). */
export interface AnthropicListedModel {
  id: string;
  display_name?: string;
  lifecycle?: string;
  capabilities?: {
    effort?: {
      supported?: boolean;
      low?: CapabilitySupport;
      medium?: CapabilitySupport;
      high?: CapabilitySupport;
      xhigh?: CapabilitySupport;
      max?: CapabilitySupport;
    } | null;
  } | null;
}

export type GroupSource<T> = { ok: true; data: T } | { ok: false; reason: "no-key" | "fetch-failed" };

export interface RegistrySources {
  openrouter: GroupSource<OpenRouterFeedModel[]>;
  openai: GroupSource<string[]>;
  anthropic: GroupSource<AnthropicListedModel[]>;
}

export interface RegistryInputs extends RegistrySources {
  /** Last good build (from KV) used per group when that group's fetch failed. */
  previous: AIModel[] | null;
}

export interface RegistryBuild {
  models: AIModel[];
  warnings: string[];
}

// ─── Ranking rules ───────────────────────────────────────────────────────────

const OPENAI_TIER_RE = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra|luna)$/;
const OPENAI_TIER_ORDER = ["astra", "sol", "terra", "luna"];
const ANTHROPIC_FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];
/** Anthropic list ids: `claude-opus-5`, `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`. */
const ANTHROPIC_ID_RE = /^claude-(fable|opus|sonnet|haiku)-(\d+(?:[.-]\d+)?)(-\d{8})?$/;

function versionOf(s: string): number {
  const n = Number(s.replace("-", "."));
  return Number.isFinite(n) ? n : -1;
}

/** Dotted, undated form of an Anthropic id, used for ranking and price lookup; null when unrecognised. */
export function anthropicCanonical(vendorModel: string): string | null {
  const m = ANTHROPIC_ID_RE.exec(vendorModel);
  if (!m) return null;
  return `claude-${m[1]}-${m[2]!.replace("-", ".")}`;
}

/** Newest generation per tier, in astra, sol, terra, luna order. */
export function rankOpenAiIds(ids: string[]): string[] {
  const best = new Map<string, { id: string; version: number }>();
  for (const id of ids) {
    const m = OPENAI_TIER_RE.exec(id);
    if (!m) continue;
    const tier = m[2]!;
    const version = versionOf(m[1]!);
    const cur = best.get(tier);
    if (!cur || version > cur.version) best.set(tier, { id, version });
  }
  return OPENAI_TIER_ORDER.flatMap((t) => {
    const b = best.get(t);
    return b ? [b.id] : [];
  });
}

/** Highest version per family, in fable, opus, sonnet, haiku order; undated alias beats a dated snapshot. */
export function rankAnthropicIds(ids: string[]): string[] {
  const best = new Map<string, { id: string; version: number; dated: boolean }>();
  for (const id of ids) {
    const m = ANTHROPIC_ID_RE.exec(id);
    if (!m) continue;
    const family = m[1]!;
    const version = versionOf(m[2]!);
    const dated = Boolean(m[3]);
    const cur = best.get(family);
    if (!cur || version > cur.version || (version === cur.version && cur.dated && !dated)) {
      best.set(family, { id, version, dated });
    }
  }
  return ANTHROPIC_FAMILY_ORDER.flatMap((f) => {
    const b = best.get(f);
    return b ? [b.id] : [];
  });
}

/**
 * A slot keeps one model: the highest version among the ids its pattern
 * matches, so a new generation replaces the old one in the same slot.
 * Group 1 = version; optional group 2 = "-preview" (Google ships Pro as
 * preview for months).
 */
interface FamilyRule {
  key: string;
  re: RegExp;
}

interface VendorRule {
  vendor: string;
  families: FamilyRule[];
  /** Specialist lines deliberately not listed; they never trigger the drift warning. */
  ignore?: RegExp[];
}

const OPENROUTER_FAMILY_TABLE: VendorRule[] = [
  {
    vendor: "google",
    // Gemini 4 renamed the tiers (Carbon top, Argon balanced, Hydrogen fast).
    // Carbon shares the flagship slot with the Gemini 3 Pro line; Hydrogen
    // costs about twice 3.8 Flash, so Flash keeps its own slot.
    families: [
      { key: "flagship", re: /^gemini-(\d+(?:\.\d+)?)-(?:carbon|pro)(-preview)?$/ },
      { key: "argon", re: /^gemini-(\d+(?:\.\d+)?)-argon(-preview)?$/ },
      { key: "hydrogen", re: /^gemini-(\d+(?:\.\d+)?)-hydrogen(-preview)?$/ },
      { key: "flash", re: /^gemini-(\d+(?:\.\d+)?)-flash(-preview)?$/ },
      { key: "flash-lite", re: /^gemini-(\d+(?:\.\d+)?)-flash-lite(-preview)?$/ },
    ],
  },
  {
    vendor: "anthropic",
    families: [
      { key: "fable", re: /^claude-fable-(\d+(?:\.\d+)?)$/ },
      { key: "opus", re: /^claude-opus-(\d+(?:\.\d+)?)$/ },
      { key: "sonnet", re: /^claude-sonnet-(\d+(?:\.\d+)?)$/ },
      { key: "haiku", re: /^claude-haiku-(\d+(?:\.\d+)?)$/ },
    ],
  },
  {
    vendor: "openai",
    families: [
      { key: "astra", re: /^gpt-(\d+(?:\.\d+)?)-astra$/ },
      { key: "sol", re: /^gpt-(\d+(?:\.\d+)?)-sol$/ },
      { key: "terra", re: /^gpt-(\d+(?:\.\d+)?)-terra$/ },
      { key: "luna", re: /^gpt-(\d+(?:\.\d+)?)-luna$/ },
    ],
  },
  {
    vendor: "x-ai",
    families: [
      { key: "plain", re: /^grok-(\d+(?:\.\d+)?)$/ },
      { key: "multi-agent", re: /^grok-(\d+(?:\.\d+)?)-multi-agent$/ },
    ],
  },
  {
    vendor: "deepseek",
    families: [
      { key: "pro", re: /^deepseek-v(\d+(?:\.\d+)?)-pro$/ },
      { key: "flash", re: /^deepseek-v(\d+(?:\.\d+)?)-flash$/ },
    ],
  },
  {
    vendor: "z-ai",
    families: [
      { key: "prime", re: /^glm-(\d+(?:\.\d+)?)-prime$/ },
      { key: "plain", re: /^glm-(\d+(?:\.\d+)?)$/ },
      { key: "flash", re: /^glm-(\d+(?:\.\d+)?)-flash$/ },
    ],
    ignore: [/-legal$/],
  },
  {
    vendor: "qwen",
    families: [
      { key: "max", re: /^qwen(\d+(?:\.\d+)?)-max$/ },
      { key: "plus", re: /^qwen(\d+(?:\.\d+)?)-plus$/ },
      { key: "flash", re: /^qwen(\d+(?:\.\d+)?)-flash$/ },
    ],
  },
  {
    vendor: "mistralai",
    // Mistral writes versions with a hyphen (mistral-large-4-0); dated ids
    // such as mistral-large-2512 never reach here (isRankableText).
    families: [
      { key: "large", re: /^mistral-large-(\d+(?:[.-]\d+)?)$/ },
      { key: "medium", re: /^mistral-medium-(\d+(?:[.-]\d+)?)$/ },
    ],
  },
];

function isRankableText(m: OpenRouterFeedModel): boolean {
  if (m.id.includes(":")) return false;
  if (/-exp$/.test(m.id) || /-\d{4}$/.test(m.id)) return false;
  const out = m.architecture?.output_modalities;
  return !out || (out.length === 1 && out[0] === "text");
}

function pickFamily(vendorModels: string[], re: RegExp): string | null {
  let best: { id: string; version: number; preview: boolean } | null = null;
  for (const id of vendorModels) {
    const m = re.exec(id);
    if (!m) continue;
    const version = versionOf(m[1]!);
    const preview = Boolean(m[2]);
    if (!best || version > best.version || (version === best.version && best.preview && !preview)) {
      best = { id, version, preview };
    }
  }
  return best?.id ?? null;
}

/** Top tier per family per vendor, vendors in catalogue order, pinned defaults always kept. */
export function rankOpenRouterText(feed: OpenRouterFeedModel[]): string[] {
  const textIds = feed.filter(isRankableText).map((m) => m.id);
  const byVendor = new Map<string, string[]>();
  for (const rule of OPENROUTER_FAMILY_TABLE) {
    const prefix = `${rule.vendor}/`;
    const vendorModels = textIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    const picks: string[] = [];
    for (const fam of rule.families) {
      const p = pickFamily(vendorModels, fam.re);
      if (p) picks.push(prefix + p);
    }
    byVendor.set(rule.vendor, picks);
  }
  for (const pinned of [...PINNED_OPENROUTER_TEXT_IDS].reverse()) {
    const vendor = pinned.split("/")[0] ?? "";
    const list = byVendor.get(vendor) ?? [];
    if (!list.includes(pinned)) list.unshift(pinned);
    byVendor.set(vendor, list);
  }
  return VENDOR_ORDER.flatMap((v) => byVendor.get(v) ?? []);
}

function isoDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Naming drift: a vendor's newest listable model (by the feed's `created`)
 * is more than a week newer than anything the rules picked for it. This is
 * how a renamed generation (Gemini 3 to Gemini 4) reaches the logs instead
 * of staying hidden.
 */
export function driftWarnings(feed: OpenRouterFeedModel[], ranked: string[]): string[] {
  const createdById = new Map(feed.map((m) => [m.id, m.created]));
  const out: string[] = [];
  for (const rule of OPENROUTER_FAMILY_TABLE) {
    const prefix = `${rule.vendor}/`;
    const candidates = feed.filter(
      (m) =>
        m.id.startsWith(prefix) &&
        isRankableText(m) &&
        typeof m.created === "number" &&
        !(rule.ignore ?? []).some((re) => re.test(m.id.slice(prefix.length))),
    );
    if (candidates.length === 0) continue;
    const newest = candidates.reduce((a, b) => ((b.created ?? 0) > (a.created ?? 0) ? b : a));
    const newestPick = Math.max(0, ...ranked.filter((id) => id.startsWith(prefix)).map((id) => createdById.get(id) ?? 0));
    if ((newest.created ?? 0) - newestPick > DRIFT_GRACE_S) {
      out.push(
        `${rule.vendor}: newest model ${newest.id} (${isoDay(newest.created ?? 0)}) is not listed; check the ranking rules for naming drift`,
      );
    }
  }
  return out;
}

/** Listed OpenRouter models that the feed says are leaving. */
function expiryWarnings(feedById: Map<string, OpenRouterFeedModel>, ids: string[]): string[] {
  return ids.flatMap((id) => {
    const exp = feedById.get(id)?.expiration_date;
    return exp ? [`openrouter: ${id} is scheduled to leave OpenRouter on ${exp}`] : [];
  });
}

// ─── Effort levels ───────────────────────────────────────────────────────────

export interface EffortInfo {
  levels: TextEffort[];
  defaultEffort: TextEffort | null;
}

const NO_EFFORT: EffortInfo = { levels: [], defaultEffort: null };

function withDefault(levels: TextEffort[], def: TextEffort | null | undefined): EffortInfo {
  return { levels, defaultEffort: def && levels.includes(def) ? def : null };
}

/**
 * Levels for a model in the OpenRouter feed. `reasoning.supported_efforts`
 * is authoritative; a reasoning block without levels means reasoning can be
 * toggled but not graded (no select); an entry without a reasoning block
 * falls back to the old rule (`reasoning` in supported_parameters gets
 * low/medium/high). Undefined when there is no such entry.
 */
export function feedEfforts(m: OpenRouterFeedModel | undefined): EffortInfo | undefined {
  if (!m) return undefined;
  const r = m.reasoning;
  if (r && typeof r === "object") {
    const levels = Array.isArray(r.supported_efforts) ? orderEfforts(r.supported_efforts) : [];
    return withDefault(levels, parseEffort(r.default_effort));
  }
  if (m.supported_parameters) {
    return { levels: m.supported_parameters.includes("reasoning") ? CLASSIC_EFFORTS : [], defaultEffort: null };
  }
  return undefined;
}

/**
 * Levels for a direct Anthropic model. The Models API reports effort as
 * `{ supported, low: { supported }, ..., max: { supported } }`; a model
 * without effort (Claude Haiku 4.5) gets none. When the list carries no
 * capabilities, the OpenRouter twin's levels are used, limited to what the
 * Messages API takes. No default is reported: the list has none, and the
 * twin's is OpenRouter's (it says "high" for Claude Opus 5.5, whose direct
 * API default is "medium").
 */
export function anthropicEfforts(m: AnthropicListedModel, twin: OpenRouterFeedModel | undefined): EffortInfo {
  const eff = m.capabilities?.effort;
  if (eff && typeof eff === "object" && typeof eff.supported === "boolean") {
    if (!eff.supported) return NO_EFFORT;
    const levels = ANTHROPIC_API_EFFORTS.filter((level) => {
      const leaf = (eff as Record<string, CapabilitySupport | boolean | undefined>)[level];
      return typeof leaf === "object" && leaf !== null && leaf.supported === true;
    });
    return { levels, defaultEffort: null };
  }
  const fromTwin = feedEfforts(twin);
  if (fromTwin) {
    return { levels: fromTwin.levels.filter((level) => ANTHROPIC_API_EFFORTS.includes(level)), defaultEffort: null };
  }
  return { levels: CLASSIC_EFFORTS, defaultEffort: null };
}

// ─── Assembly ────────────────────────────────────────────────────────────────

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** "OpenAI: GPT-6 Astra" -> "GPT-6 Astra". */
function cleanFeedName(name: string | undefined): string | undefined {
  const n = name?.replace(/^[^:]+:\s*/, "").trim();
  return n || undefined;
}

function formatOpenAiName(vendorModel: string): string {
  const m = OPENAI_TIER_RE.exec(vendorModel);
  if (!m) return vendorModel;
  const tier = m[2]!;
  return `GPT-${m[1]} ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}

/** Feed key that carries a model's price: its OpenRouter slug, canonicalised for Anthropic ids. */
export function priceKeyFor(id: string): string {
  const { route, model } = parseModelId(id);
  if (route === "anthropic") return `anthropic/${anthropicCanonical(model) ?? model}`;
  return priceTwin(id);
}

/** Pure: join the three sources into the served list. Unit-tested against recorded lists. */
export function buildRegistry(inputs: RegistryInputs): RegistryBuild {
  const warnings: string[] = [];
  const feed = inputs.openrouter.ok ? inputs.openrouter.data : [];
  const feedById = new Map(feed.map((m) => [m.id, m]));
  const snapshot = catalogModels();
  const snapshotById = new Map(snapshot.map((m) => [m.id, m]));
  const previous = inputs.previous ?? [];

  const priceFor = (id: string): { input: number; output: number; live: boolean } => {
    const twin = feedById.get(priceKeyFor(id));
    const prompt = Number(twin?.pricing?.prompt);
    const completion = Number(twin?.pricing?.completion);
    if (twin && Number.isFinite(prompt) && Number.isFinite(completion)) {
      return { input: round3(prompt * 1e6), output: round3(completion * 1e6), live: true };
    }
    const fb = fallbackPriceFor(id);
    if (fb) return { input: fb.input, output: fb.output, live: false };
    return { input: 0, output: 0, live: false };
  };

  const make = (id: string, kind: ModelKind, name: string, effort: EffortInfo): AIModel => {
    const { route, model } = parseModelId(id);
    const vendor = route === "openrouter" ? (model.split("/")[0] ?? "") : route;
    const snap = snapshotById.get(id);
    const price = priceFor(id);
    return {
      id,
      name,
      kind,
      provider: route,
      providerLabel: ROUTE_LABELS[route],
      vendor,
      vendorLabel: vendorLabel(vendor),
      description: snap?.description ?? "",
      costPer1MInput: price.input,
      costPer1MOutput: price.output,
      supportsEffort: effort.levels.length > 0,
      effortLevels: effort.levels,
      ...(effort.defaultEffort ? { defaultEffort: effort.defaultEffort } : {}),
      recommended: snap?.recommended === true,
      livePricing: price.live,
    };
  };

  const snapshotEfforts = (id: string): EffortInfo => {
    const snap = snapshotById.get(id);
    if (!snap || !snap.supportsEffort) return NO_EFFORT;
    return withDefault(snap.effortLevels ?? CLASSIC_EFFORTS, snap.defaultEffort);
  };

  const fromSnapshot = (route: ModelRoute): AIModel[] =>
    snapshot.filter((m) => m.provider === route).map((m) => make(m.id, m.kind, m.name, snapshotEfforts(m.id)));

  const fallbackGroup = (route: ModelRoute): AIModel[] => {
    const prev = previous.filter((m) => m.provider === route);
    return prev.length > 0 ? prev : fromSnapshot(route);
  };

  const openRouterName = (id: string): string =>
    cleanFeedName(feedById.get(id)?.name) ?? snapshotById.get(id)?.name ?? (id.split("/")[1] ?? id);

  /** Feed first; a pinned id the feed no longer lists keeps its snapshot levels. */
  const openRouterEfforts = (id: string): EffortInfo => feedEfforts(feedById.get(id)) ?? snapshotEfforts(id);

  let openrouter: AIModel[];
  if (inputs.openrouter.ok) {
    const ranked = rankOpenRouterText(feed);
    warnings.push(...driftWarnings(feed, ranked), ...expiryWarnings(feedById, ranked));
    openrouter = [
      ...ranked.map((id) => make(id, "text", openRouterName(id), openRouterEfforts(id))),
      ...snapshot
        .filter((m) => m.provider === "openrouter" && m.kind === "image")
        .map((m) => make(m.id, "image", m.name, NO_EFFORT)),
    ];
  } else {
    openrouter = fallbackGroup("openrouter");
  }

  let openai: AIModel[] = [];
  if (inputs.openai.ok) {
    openai = rankOpenAiIds(inputs.openai.data).map((vendorModel) => {
      const id = `openai-api/${vendorModel}`;
      const name =
        snapshotById.get(id)?.name ?? cleanFeedName(feedById.get(`openai/${vendorModel}`)?.name) ?? formatOpenAiName(vendorModel);
      // OpenAI's list carries no capabilities; the OpenRouter twin reports the
      // same model's levels (GPT-6 Astra and GPT-6.1 Sol take no "none").
      return make(id, "text", name, feedEfforts(feedById.get(`openai/${vendorModel}`)) ?? snapshotEfforts(id));
    });
  } else if (inputs.openai.reason === "fetch-failed") {
    openai = fallbackGroup("openai");
  } else {
    warnings.push("openai: API key not configured; group hidden");
  }

  let anthropic: AIModel[] = [];
  if (inputs.anthropic.ok) {
    // A retired model stays in Anthropic's catalogue, but every call to it fails.
    const callable = inputs.anthropic.data.filter((m) => m.lifecycle !== "retired");
    const listedById = new Map(callable.map((m) => [m.id, m]));
    anthropic = rankAnthropicIds(callable.map((m) => m.id)).map((vendorModel) => {
      const listed = listedById.get(vendorModel);
      const id = `anthropic-api/${vendorModel}`;
      const name =
        listed?.display_name?.trim() ||
        snapshotById.get(id)?.name ||
        cleanFeedName(feedById.get(priceKeyFor(id))?.name) ||
        vendorModel;
      return make(id, "text", name, listed ? anthropicEfforts(listed, feedById.get(priceKeyFor(id))) : snapshotEfforts(id));
    });
  } else if (inputs.anthropic.reason === "fetch-failed") {
    anthropic = fallbackGroup("anthropic");
  } else {
    warnings.push("anthropic: API key not configured; group hidden");
  }

  const fetched: Array<[ModelRoute, AIModel[]]> = [
    ["openrouter", openrouter.filter((m) => m.kind === "text")],
    ["openai", openai],
    ["anthropic", anthropic],
  ];
  for (const [route, group] of fetched) {
    if (inputs[route].ok && group.length < 2) {
      warnings.push(`${route}: only ${group.length} text model(s) ranked; check vendor naming drift`);
    }
  }

  return { models: [...openrouter, ...openai, ...anthropic], warnings };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

async function fetchOpenRouterFeed(doFetch: typeof fetch): Promise<GroupSource<OpenRouterFeedModel[]>> {
  try {
    const res = await doFetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: OpenRouterFeedModel[] };
    if (!Array.isArray(data.data) || data.data.length === 0) throw new Error("empty catalogue");
    return { ok: true, data: data.data };
  } catch (err) {
    console.warn("[model-registry] OpenRouter feed unavailable:", err);
    return { ok: false, reason: "fetch-failed" };
  }
}

async function fetchOpenAiIds(apiKey: string, doFetch: typeof fetch): Promise<GroupSource<string[]>> {
  try {
    const res = await doFetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) throw new Error("empty list");
    return { ok: true, data: ids };
  } catch (err) {
    console.warn("[model-registry] OpenAI model list unavailable:", err);
    return { ok: false, reason: "fetch-failed" };
  }
}

async function fetchAnthropicModels(apiKey: string, doFetch: typeof fetch): Promise<GroupSource<AnthropicListedModel[]>> {
  try {
    const all: AnthropicListedModel[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = `${ANTHROPIC_MODELS_URL}?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
      const res = await doFetch(url, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data?: AnthropicListedModel[]; has_more?: boolean; last_id?: string | null };
      all.push(...(data.data ?? []).filter((m) => typeof m?.id === "string"));
      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }
    if (all.length === 0) throw new Error("empty list");
    return { ok: true, data: all };
  } catch (err) {
    console.warn("[model-registry] Anthropic model list unavailable:", err);
    return { ok: false, reason: "fetch-failed" };
  }
}

/** The three lists in parallel, 10 s each; a missing key skips that vendor entirely. */
export async function fetchRegistrySources(keys: ProviderKeys, fetchImpl?: typeof fetch): Promise<RegistrySources> {
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const [openrouter, openai, anthropic] = await Promise.all([
    fetchOpenRouterFeed(doFetch),
    keys.openai
      ? fetchOpenAiIds(keys.openai, doFetch)
      : Promise.resolve<GroupSource<string[]>>({ ok: false, reason: "no-key" }),
    keys.anthropic
      ? fetchAnthropicModels(keys.anthropic, doFetch)
      : Promise.resolve<GroupSource<AnthropicListedModel[]>>({ ok: false, reason: "no-key" }),
  ]);
  return { openrouter, openai, anthropic };
}

// ─── KV-cached entry points ──────────────────────────────────────────────────

async function readModels(kv: KVNamespace, key: string): Promise<AIModel[] | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AIModel[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A source we were configured to fetch came back failed. A missing key is
 * configuration, not an outage: it hides its group and must not shorten the
 * cache or block the last-good write.
 */
function anyFeedDown(sources: RegistrySources): boolean {
  const groups: Array<GroupSource<unknown>> = [sources.openrouter, sources.openai, sources.anthropic];
  return groups.some((g) => !g.ok && g.reason !== "no-key");
}

/** The served list: KV cache first, else a fresh build (cached 1 h, or 60 s when any feed was down). */
export async function getLiveModels(kv: KVNamespace, keys: ProviderKeys): Promise<AIModel[]> {
  const cached = await readModels(kv, MODELS_KV_KEY);
  if (cached) return cached;

  const previous = await readModels(kv, MODELS_LAST_GOOD_KV_KEY);
  const sources = await fetchRegistrySources(keys);
  const { models, warnings } = buildRegistry({ ...sources, previous });
  for (const w of warnings) console.warn(`[model-registry] ${w}`);

  const json = JSON.stringify(models);
  const feedDown = anyFeedDown(sources);
  await kv.put(MODELS_KV_KEY, json, { expirationTtl: feedDown ? DEGRADED_KV_TTL : MODELS_KV_TTL });
  if (!feedDown) await kv.put(MODELS_LAST_GOOD_KV_KEY, json);
  return models;
}

/** Look up a listed model (validation and effort gating); kind-checked when asked. */
export async function getModel(
  kv: KVNamespace,
  keys: ProviderKeys,
  modelId: string,
  kind?: ModelKind,
): Promise<AIModel | undefined> {
  const id = modelId.trim();
  if (!id) return undefined;
  const models = await getLiveModels(kv, keys);
  return models.find((m) => m.id === id && (!kind || m.kind === kind));
}

export function providerKeysFromEnv(env: {
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}): ProviderKeys {
  return {
    openrouter: env.OPENROUTER_API_KEY || undefined,
    openai: env.OPENAI_API_KEY || undefined,
    anthropic: env.ANTHROPIC_API_KEY || undefined,
  };
}

/** A known effort level (none to max), or undefined. Whether a model takes it is effortFor's job. */
export function parseTextEffort(v: unknown): TextEffort | undefined {
  return parseEffort(v);
}

/** Error text for an effort value that is not on the ladder. */
export const EFFORT_VALUES_MESSAGE = "effort must be one of none, minimal, low, medium, high, xhigh, max";

/**
 * The effort to send for a listed model: the requested level when the model
 * takes it, else undefined (the model's own default) plus the dropped level,
 * so callers log and audit what will really run rather than a level the
 * vendor would reject.
 */
export function effortFor(
  model: Pick<AIModel, "effortLevels">,
  requested: TextEffort | undefined,
): { effort: TextEffort | undefined; dropped: TextEffort | null } {
  if (!requested) return { effort: undefined, dropped: null };
  return model.effortLevels.includes(requested)
    ? { effort: requested, dropped: null }
    : { effort: undefined, dropped: requested };
}
