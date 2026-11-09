import type { ChatUsage } from "./types";

/**
 * The cost log (`ai_usage_log`): one row per AI call, with the model, tokens
 * and an estimated cost, so site-generation spend can be traced per shop and
 * per job. Before this, only the shop chatbot wrote rows; the research and
 * text workers that build every website only printed token counts to logs.
 *
 * Prices come from the API worker's model list, which it caches in the KV
 * namespace the background workers share: the same list (and so the same
 * price) the audit trail's `ai.call` entries use. No price is ever guessed:
 * when the model isn't listed, or the list can't be read, the row keeps its
 * tokens, the cost stays 0 and `cost_basis` stays NULL, so it reads as
 * "unknown", never as "free".
 *
 * Image calls are the exception (`pricing: { from: "reported" }`): OpenRouter
 * bills image output at its own `image_output` rate, which the list does not
 * carry, so a list price would under-state them many times over. They record
 * the provider's billed figure (`usage.cost`) instead, and never fall back to
 * the list when it is missing.
 */

/** The API worker's served model list (KV). Fresh copy first, then the no-expiry last good one. */
export const MODELS_KV_KEY = "ai:models:v3";
export const MODELS_LAST_GOOD_KV_KEY = "ai:models:v3:last";

/**
 * `live`: priced from the OpenRouter feed. `catalog`: the list's snapshot
 * fallback price. `reported`: the provider's own billed figure for the call
 * (OpenRouter `usage.cost`, in USD credits). Written to `ai_usage_log.cost_basis`;
 * migration 050's comment predates `reported`.
 */
export type CostBasis = "live" | "catalog" | "reported";

/**
 * How a call is priced. `model_list` (the default) prices tokens from the
 * API's model list. `reported` uses only the provider's billed figure: a
 * missing or unusable one leaves the call unpriced and the list is never read.
 */
export type UsagePricing = { from: "model_list" } | { from: "reported"; usd: number | null };

export interface UsageCost {
  costUsd: number;
  basis: CostBasis;
}

/** Rounded like the audit trail's estimated_cost_usd, so the two agree. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Pure: the cost of one call from the API's model list (an array of AIModel:
 * `id`, `costPer1MInput`, `costPer1MOutput`, `livePricing`). Null when the model
 * isn't listed or has no price (the list uses 0/0 for "no price").
 */
export function costFromModelList(list: unknown, modelId: string, usage: ChatUsage): UsageCost | null {
  if (!Array.isArray(list)) return null;
  const entry = list.find((m): m is Record<string, unknown> => !!m && typeof m === "object" && (m as { id?: unknown }).id === modelId);
  if (!entry) return null;
  const input = entry.costPer1MInput;
  const output = entry.costPer1MOutput;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input < 0 || output < 0 || (input === 0 && output === 0)) return null;
  return {
    costUsd: round6((usage.inputTokens * input + usage.outputTokens * output) / 1_000_000),
    basis: entry.livePricing === true ? "live" : "catalog",
  };
}

export interface UsageKv {
  get(key: string): Promise<string | null>;
}

/** The API's model list, or null when neither KV copy is readable. */
export async function readModelList(kv: UsageKv): Promise<unknown[] | null> {
  for (const key of [MODELS_KV_KEY, MODELS_LAST_GOOD_KV_KEY]) {
    try {
      const raw = await kv.get(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Unreadable copy: try the next one.
    }
  }
  return null;
}

export interface UsageDb {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

export interface AiUsageRecord {
  shopId: string | null;
  /** e.g. "pivot-parlor-research". */
  workerName: string;
  /** The route-qualified id that was called (the model list is keyed by it). */
  modelId: string;
  /** e.g. "site_research". */
  usageType: string;
  /** Null when the provider returned no token counts. */
  usage: ChatUsage | null;
  jobId: string | null;
  /** Defaults to `{ from: "model_list" }`. */
  pricing?: UsagePricing;
}

/** A billed figure the provider reported, or null when there is none to trust. */
function reportedCost(usd: number | null): UsageCost | null {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return null;
  return { costUsd: round6(usd), basis: "reported" };
}

/**
 * Writes one cost-log row and returns the cost it wrote (null when unpriced,
 * when there is no usage, or when the insert failed). Never throws: a cost-log
 * failure is logged and must not fail the site generation that made the call.
 */
export async function recordAiUsage(
  env: { DB: UsageDb; KV: UsageKv },
  record: AiUsageRecord,
  log: (message: string, err?: unknown) => void = (message, err) => console.error(message, err ?? "")
): Promise<UsageCost | null> {
  try {
    const input = record.usage?.inputTokens ?? 0;
    const output = record.usage?.outputTokens ?? 0;
    let cost: UsageCost | null = null;
    const pricing = record.pricing ?? { from: "model_list" };
    if (pricing.from === "reported") {
      cost = reportedCost(pricing.usd);
    } else if (record.usage) {
      try {
        cost = costFromModelList(await readModelList(env.KV), record.modelId, record.usage);
      } catch (err) {
        log(`[ai-usage] could not price ${record.modelId}; recording tokens only`, err);
      }
    }
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, cost_basis, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        record.shopId,
        record.workerName,
        record.modelId,
        record.usageType,
        input,
        output,
        input + output,
        cost?.costUsd ?? 0,
        cost?.basis ?? null,
        record.jobId
      )
      .run();
    return cost;
  } catch (err) {
    log(`[ai-usage] could not record usage for ${record.workerName} job=${record.jobId ?? "-"}`, err);
    return null;
  }
}
