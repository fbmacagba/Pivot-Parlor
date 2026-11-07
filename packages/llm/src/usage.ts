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
 */

/** The API worker's served model list (KV). Fresh copy first, then the no-expiry last good one. */
export const MODELS_KV_KEY = "ai:models:v3";
export const MODELS_LAST_GOOD_KV_KEY = "ai:models:v3:last";

/** `live`: priced from the OpenRouter feed. `catalog`: the list's snapshot fallback price. */
export type CostBasis = "live" | "catalog";

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
}

/**
 * Writes one cost-log row. Never throws: a cost-log failure is logged and must
 * not fail the site generation that made the call.
 */
export async function recordAiUsage(
  env: { DB: UsageDb; KV: UsageKv },
  record: AiUsageRecord,
  log: (message: string, err?: unknown) => void = (message, err) => console.error(message, err ?? "")
): Promise<void> {
  try {
    const input = record.usage?.inputTokens ?? 0;
    const output = record.usage?.outputTokens ?? 0;
    let cost: UsageCost | null = null;
    if (record.usage) {
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
  } catch (err) {
    log(`[ai-usage] could not record usage for ${record.workerName} job=${record.jobId ?? "-"}`, err);
  }
}
