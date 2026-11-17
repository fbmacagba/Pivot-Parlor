/**
 * Pip, the marketing site's chat widget. The website keeps its hourly
 * per-visitor limit and its body checks (apps/web/app/routes/api.chat.tsx) and
 * hands the cleaned turns to the MarketingChat entrypoint (../marketing-chat.ts),
 * which answers here so every reply is audited and in the cost log: one
 * anonymous `ai.call` per model attempt, written before the call (a refused
 * entry means no call), and one `ai_usage_log` row per answered reply.
 *
 * Moved unchanged from the website: the prompt, the two models and the
 * 180-token cap. The call stays a direct OpenRouter request outside
 * @repo/llm, as the website's was (the multi-provider spec's non-goals).
 *
 * No visitor or model text reaches the audit trail or a log line: the errors
 * thrown inside the audited call carry fixed messages and an HTTP status only.
 * Failures log with console.warn, never console.error, which on this worker
 * opens a Workers Issue and emails the owner.
 */

import { AuditWriteError, auditAiCall, createAuditRecorder } from "@repo/audit";
import { recordAiUsage, type ChatUsage, type UsageCost } from "@repo/llm";
import { WORKER_NAME } from "../audit/context.js";

export const MARKETING_CHAT_PRIMARY_MODEL = "google/gemini-3.1-flash-lite-preview";
export const MARKETING_CHAT_FALLBACK_MODEL = "google/gemini-2.5-flash-lite";
export const MARKETING_CHAT_MAX_TOKENS = 180;
/** The `ai.call` purpose and the `ai_usage_log` usage type. */
export const MARKETING_CHAT_PURPOSE = "marketing_chat";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TURN_CHARS = 2000;
const MAX_TURNS = 10;
/** The visitor's address as the website read it from CF-Connecting-IP. */
const IP = /^[0-9a-fA-F.:]{3,45}$/;

/** Moved verbatim from the website (apps/web/app/routes/api.chat.tsx). */
export const MARKETING_CHAT_SYSTEM_PROMPT = `You are Pip, a warm and friendly chat assistant for Pivot Parlor, a booking platform for UK beauty and barber shops. You are polite, conversational, and genuinely helpful to everyone you meet.

RESPONSE LENGTH (NON-NEGOTIABLE):
- Every reply must be 3 lines or fewer. Hard limit. No exceptions.
- One line = one short sentence. Never write a paragraph.
- If you feel like writing more, cut it. Say less.

YOUR PERSONALITY:
- Always warm, polite and welcoming, no matter who you are talking to.
- Never dismissive. Every visitor could be a future shop owner, know one, or refer one.
- Treat every conversation as a chance to make a good impression for Pivot Parlor.
- End every conversation on a positive note, even if the visitor is just browsing.

YOUR JOB (follow this flow naturally):
1. Find out if the visitor owns, manages, or knows someone who runs a beauty or barber shop.
2. If YES (they own or manage a shop): pitch Pivot Parlor in one sentence and ask one helpful follow-up question. Guide them to pivotparlor.com/contact to get started.
3. If they KNOW someone who owns a shop: warmly encourage them to share Pivot Parlor with that person. Give them something simple to share (e.g. "Tell them to check out pivotparlor.com. It could save them a lot of money every month.").
4. If they are JUST BROWSING or NOT a shop owner: be friendly and curious. Ask what brought them here. Always close with a warm invitation to share Pivot Parlor with anyone who runs a salon or barber shop.

REFERRAL MINDSET (always remember):
- Someone who is "just browsing" might have a friend, family member or colleague who owns a shop.
- A positive, warm conversation plants a seed. Be that seed.
- Never end with "this chat is for shop owners only." That is rude and closes doors.

KEY FACTS (only use what is relevant):
- £100 one-time setup fee. No monthly fees. 10% commission on completed bookings only.
- AI builds a fully branded booking website for the shop in 24 hours.
- Customers can book online 24/7. Staff scheduling and automated reminders included.
- Available for beauty parlours and barber shops across the UK.

RULES:
- No bullet points. No lists. Plain sentences only.
- No em-dashes. Use two sentences instead.
- No corporate language or filler words.
- Always be the most polite version of yourself, even if someone is dismissive or rude.`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** What the website sends: its cleaned turns and the visitor's address. */
export interface MarketingChatInput {
  messages: ChatTurn[];
  /** CF-Connecting-IP, or absent. Never a placeholder. */
  ip?: string | null;
}

/**
 * `invalid`: nothing a model may see. `unavailable`: no key, or the audit
 * entry could not be written (no model was called). `failed`: both models
 * were tried and neither answered.
 */
export type MarketingChatResult = { ok: true; reply: string } | { ok: false; error: "invalid" | "unavailable" | "failed" };

export interface MarketingChatEnv {
  DB: D1Database;
  KV: KVNamespace;
  OPENROUTER_API_KEY?: string;
}

/**
 * The turns a model may see: user and assistant only (an injected "system"
 * row is dropped), each capped at 2,000 characters, the newest 10. The
 * website's rule, applied again because the entrypoint trusts nothing it is sent.
 */
export function cleanTurns(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is ChatTurn => {
      if (!m || typeof m !== "object") return false;
      const t = m as { role?: unknown; content?: unknown };
      return (t.role === "user" || t.role === "assistant") && typeof t.content === "string";
    })
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) }))
    .slice(-MAX_TURNS);
}

/** A refused call. Its status only: the provider's body could echo the visitor. */
export class MarketingChatHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`OpenRouter error ${status}`);
    this.name = "MarketingChatHttpError";
    this.status = status;
  }
}

/** A 200 whose body is not JSON: nothing says what, if anything, was billed. */
export class MarketingChatUnreadableError extends Error {
  constructor() {
    super("unreadable marketing chat reply");
    this.name = "MarketingChatUnreadableError";
  }
}

/** A model answered without text. Thrown after its usage row is written. */
export class MarketingChatEmptyReplyError extends Error {
  constructor() {
    super("empty marketing chat reply");
    this.name = "MarketingChatEmptyReplyError";
  }
}

function usageOf(data: unknown): ChatUsage | null {
  const u = data && typeof data === "object" ? (data as { usage?: unknown }).usage : undefined;
  if (!u || typeof u !== "object") return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  const { prompt_tokens, completion_tokens } = u as { prompt_tokens?: unknown; completion_tokens?: unknown };
  return { inputTokens: n(prompt_tokens), outputTokens: n(completion_tokens) };
}

interface Answered {
  text: string;
  usage: ChatUsage | null;
  cost: UsageCost | null;
}

/**
 * One model call. Every reply OpenRouter answered is billed, text or not, so
 * its row is written before the text is checked. A refused call (network or
 * HTTP error) and an unreadable 200 write nothing. A reply without a `usage`
 * block still gets a row, with no tokens and no cost basis (unknown, never
 * free), as theme and chatbot calls do.
 */
async function callModel(
  env: MarketingChatEnv,
  apiKey: string,
  model: string,
  turns: ChatTurn[],
  requestId: string
): Promise<Answered> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pivotparlor.com",
      "X-Title": "Pivot Parlor",
    },
    body: JSON.stringify({
      model,
      max_tokens: MARKETING_CHAT_MAX_TOKENS,
      messages: [{ role: "system", content: MARKETING_CHAT_SYSTEM_PROMPT }, ...turns],
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new MarketingChatHttpError(res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new MarketingChatUnreadableError();
  }

  const usage = usageOf(data);
  const cost = await recordAiUsage(env, {
    shopId: null,
    workerName: WORKER_NAME,
    modelId: model,
    usageType: MARKETING_CHAT_PURPOSE,
    usage,
    jobId: requestId,
  });

  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  if (!text) throw new MarketingChatEmptyReplyError();
  return { text, usage, cost };
}

/** A failure's name and status for a log line, never its message. */
function failureLabel(err: unknown): string {
  if (err instanceof MarketingChatHttpError) return `${err.name} ${err.status}`;
  return err instanceof Error ? err.name : "unknown";
}

/**
 * One visitor message: the primary model, then the fallback. Both attempts
 * share one request id, which every `ai.call` entry and usage row carries, so
 * the historical import never copies these rows as false historical entries.
 */
export async function answerMarketingChat(env: MarketingChatEnv, input: unknown): Promise<MarketingChatResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid" };
  const o = input as { messages?: unknown; ip?: unknown };
  const turns = cleanTurns(o.messages);
  if (!turns.length) return { ok: false, error: "invalid" };
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, error: "unavailable" };

  const ip = typeof o.ip === "string" && IP.test(o.ip) ? o.ip : null;
  const requestId = crypto.randomUUID();
  const rec = createAuditRecorder({ db: env.DB, worker: WORKER_NAME, via: "api", actor: { type: "anonymous", ip }, requestId });

  for (const model of [MARKETING_CHAT_PRIMARY_MODEL, MARKETING_CHAT_FALLBACK_MODEL]) {
    try {
      const answered = await auditAiCall(
        rec,
        { purpose: MARKETING_CHAT_PURPOSE, model, shopId: null, origin: null },
        () => callModel(env, apiKey, model, turns, requestId),
        (r) => ({
          model,
          route: "openrouter",
          inputTokens: r.usage?.inputTokens ?? null,
          outputTokens: r.usage?.outputTokens ?? null,
          costUsd: r.cost?.costUsd ?? null,
          costBasis: r.cost?.basis ?? null,
        })
      );
      return { ok: true, reply: answered.text };
    } catch (err) {
      // The started entry could not be written, so this model was never called.
      if (err instanceof AuditWriteError) return { ok: false, error: "unavailable" };
      console.warn(`[marketing-chat] ${model} failed: ${failureLabel(err)}`);
    }
  }
  return { ok: false, error: "failed" };
}
