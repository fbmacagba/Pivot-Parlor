// API route: POST /api/chat
// Pip, the marketing chat widget. The website keeps the per-visitor hourly
// limit and the body checks; the API's MarketingChat entrypoint
// (apps/worker/src/marketing-chat.ts, over the MARKETING_CHAT service binding)
// calls the model, so each reply is audited and in the cost log. The prompt
// and the two models moved there unchanged.

import type { ActionFunctionArgs } from "react-router";
import { readJsonObject } from "@repo/utils";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** What the API's MarketingChat entrypoint answers
 *  (apps/worker/src/services/marketing-chat.ts). */
type MarketingChatResult =
  | { ok: true; reply: string }
  | { ok: false; error: "invalid" | "unavailable" | "failed" };

/** The MARKETING_CHAT service binding (apps/web/wrangler.toml). */
export interface MarketingChatBinding {
  reply(input: { messages: ChatTurn[]; ip: string | null }): Promise<MarketingChatResult>;
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
// 20 messages per IP per hour, stored in KV with 1h TTL

const RATE_LIMIT = 20;
const RATE_WINDOW_SECONDS = 60 * 60; // 1 hour

async function checkRateLimit(
  kv: KVNamespace | undefined,
  ip: string
): Promise<{ allowed: boolean; remaining: number }> {
  if (!kv) return { allowed: true, remaining: RATE_LIMIT }; // no KV = skip

  const key = `chat:rate:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= RATE_LIMIT) return { allowed: false, remaining: 0 };

  await kv.put(key, String(count + 1), { expirationTtl: RATE_WINDOW_SECONDS });
  return { allowed: true, remaining: RATE_LIMIT - count - 1 };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { MARKETING_CHAT?: MarketingChatBinding; KV?: KVNamespace };

  const chat = env.MARKETING_CHAT;
  if (!chat) {
    return Response.json({ error: "Chat unavailable." }, { status: 503 });
  }

  // Rate limit by IP
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ||
    "unknown";

  const { allowed, remaining } = await checkRateLimit(env.KV, ip);
  if (!allowed) {
    return Response.json(
      { error: "You've sent too many messages. Please try again in an hour." },
      { status: 429 }
    );
  }

  // A body that is not a JSON object, or messages that is not a list, is the
  // caller's mistake: a 400, never a thrown error (a 500 and an alert).
  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const rawMessages = body.messages ?? [];
  if (!Array.isArray(rawMessages)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const messages = rawMessages as Array<{ role?: unknown; content?: unknown } | null>;
  if (!messages.length) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  // The client only ever holds user/assistant turns — anything else (e.g. an
  // injected "system" row) is dropped, and each message is length-capped so a
  // hostile client cannot inflate prompt tokens. Newest 10 turns only.
  const safeMessages = messages
    .filter(
      (m): m is ChatTurn =>
        !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-10);
  if (!safeMessages.length) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  let result: MarketingChatResult;
  try {
    // CF-Connecting-IP only: the audit trail's visitor is a real address or
    // none, never the limiter's fallbacks above.
    result = await chat.reply({ messages: safeMessages, ip: request.headers.get("CF-Connecting-IP") });
  } catch (err) {
    console.error("[api.chat] MarketingChat call failed:", err instanceof Error ? err.name : "unknown");
    return Response.json({ error: "Chat unavailable. Please try again." }, { status: 502 });
  }

  if (result.ok) return Response.json({ reply: result.reply, remaining });
  if (result.error === "invalid") {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }
  if (result.error === "unavailable") {
    return Response.json({ error: "Chat unavailable." }, { status: 503 });
  }
  console.warn("[api.chat] both models failed");
  return Response.json({ error: "Chat unavailable. Please try again." }, { status: 502 });
}
