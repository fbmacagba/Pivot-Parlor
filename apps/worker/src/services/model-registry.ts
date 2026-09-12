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
import { parseModelId, priceTwin, type ProviderKeys } from "@repo/llm";

export type { TextEffort };

/** Default model for the theme generator (site pipeline default lives in shops.ts). */
export const DEFAULT_THEME_MODEL = "anthropic/claude-sonnet-5";

export const MODELS_KV_KEY = "ai:models:v3";
/** Last successful build, no expiry: the per-group fallback when a vendor fetch fails. */
export const MODELS_LAST_GOOD_KV_KEY = "ai:models:v3:last";
const MODELS_KV_TTL = 3600; // 1h — pricing moves slowly; avoids hammering three catalogues
const DEGRADED_KV_TTL = 60; // feed down: retry soon, but not on every request
const FETCH_TIMEOUT_MS = 10_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const ALL_EFFORTS: TextEffort[] = ["low", "medium", "high"];
/** OpenRouter ids that stay listed even when the ranking would drop them. */
const PINNED_OPENROUTER_TEXT_IDS = [DEFAULT_TEXT_MODEL_ID, DEFAULT_THEME_MODEL];

export interface OpenRouterFeedModel {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
}

export interface AnthropicListedModel {
  id: string;
  display_name?: string;
  capabilities?: { effort?: { supported?: string[] } | string[] };
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

/** Group 1 = version; optional group 2 = "-preview" (Google ships Pro as preview for months). */
interface FamilyRule {
  key: string;
  re: RegExp;
}

const OPENROUTER_FAMILY_TABLE: Array<{ vendor: string; families: FamilyRule[] }> = [
  {
    vendor: "google",
    families: [
      { key: "pro", re: /^gemini-(\d+(?:\.\d+)?)-pro(-preview)?$/ },
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

function anthropicEffortLevels(m: AnthropicListedModel): TextEffort[] {
  const eff = m.capabilities?.effort;
  if (eff === undefined) return ALL_EFFORTS;
  const supported = Array.isArray(eff) ? eff : eff.supported;
  if (!Array.isArray(supported)) return ALL_EFFORTS;
  return ALL_EFFORTS.filter((level) => supported.includes(level));
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

  const make = (id: string, kind: ModelKind, name: string, effortLevels: TextEffort[]): AIModel => {
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
      supportsEffort: effortLevels.length > 0,
      effortLevels,
      recommended: snap?.recommended === true,
      livePricing: price.live,
    };
  };

  const fromSnapshot = (route: ModelRoute): AIModel[] =>
    snapshot
      .filter((m) => m.provider === route)
      .map((m) => make(m.id, m.kind, m.name, m.supportsEffort ? ALL_EFFORTS : []));

  const fallbackGroup = (route: ModelRoute): AIModel[] => {
    const prev = previous.filter((m) => m.provider === route);
    return prev.length > 0 ? prev : fromSnapshot(route);
  };

  const openRouterName = (id: string): string =>
    cleanFeedName(feedById.get(id)?.name) ?? snapshotById.get(id)?.name ?? (id.split("/")[1] ?? id);

  const openRouterEfforts = (id: string): TextEffort[] => {
    const f = feedById.get(id);
    if (f?.supported_parameters) return f.supported_parameters.includes("reasoning") ? ALL_EFFORTS : [];
    return snapshotById.get(id)?.supportsEffort === false ? [] : ALL_EFFORTS;
  };

  let openrouter: AIModel[];
  if (inputs.openrouter.ok) {
    openrouter = [
      ...rankOpenRouterText(feed).map((id) => make(id, "text", openRouterName(id), openRouterEfforts(id))),
      ...snapshot
        .filter((m) => m.provider === "openrouter" && m.kind === "image")
        .map((m) => make(m.id, "image", m.name, [])),
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
      return make(id, "text", name, ALL_EFFORTS);
    });
  } else if (inputs.openai.reason === "fetch-failed") {
    openai = fallbackGroup("openai");
  } else {
    warnings.push("openai: API key not configured; group hidden");
  }

  let anthropic: AIModel[] = [];
  if (inputs.anthropic.ok) {
    const listedById = new Map(inputs.anthropic.data.map((m) => [m.id, m]));
    anthropic = rankAnthropicIds(inputs.anthropic.data.map((m) => m.id)).map((vendorModel) => {
      const listed = listedById.get(vendorModel);
      const id = `anthropic-api/${vendorModel}`;
      const name =
        listed?.display_name?.trim() ||
        snapshotById.get(id)?.name ||
        cleanFeedName(feedById.get(priceKeyFor(id))?.name) ||
        vendorModel;
      return make(id, "text", name, listed ? anthropicEffortLevels(listed) : ALL_EFFORTS);
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

/** The served list: KV cache first, else a fresh build (cached 1 h, or 60 s when the feed was down). */
export async function getLiveModels(kv: KVNamespace, keys: ProviderKeys): Promise<AIModel[]> {
  const cached = await readModels(kv, MODELS_KV_KEY);
  if (cached) return cached;

  const previous = await readModels(kv, MODELS_LAST_GOOD_KV_KEY);
  const sources = await fetchRegistrySources(keys);
  const { models, warnings } = buildRegistry({ ...sources, previous });
  for (const w of warnings) console.warn(`[model-registry] ${w}`);

  const json = JSON.stringify(models);
  await kv.put(MODELS_KV_KEY, json, { expirationTtl: sources.openrouter.ok ? MODELS_KV_TTL : DEGRADED_KV_TTL });
  if (sources.openrouter.ok) await kv.put(MODELS_LAST_GOOD_KV_KEY, json);
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

export function parseTextEffort(v: unknown): TextEffort | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}
