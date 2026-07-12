// API route: POST /api/chat
// Proxies messages to OpenRouter — keeps API key out of the browser.
// Primary model: google/gemini-3.1-flash-lite-preview
// Fallback model: google/gemini-2.5-flash-lite

import type { ActionFunctionArgs } from "@remix-run/cloudflare";

const SYSTEM_PROMPT = `You are Pip, a warm and friendly chat assistant for Pivot Parlor — a booking platform for UK beauty and barber shops. You are polite, conversational, and genuinely helpful to everyone you meet.

RESPONSE LENGTH — NON-NEGOTIABLE:
- Every reply must be 3 lines or fewer. Hard limit. No exceptions.
- One line = one short sentence. Never write a paragraph.
- If you feel like writing more, cut it. Say less.

YOUR PERSONALITY:
- Always warm, polite and welcoming — no matter who you are talking to.
- Never dismissive. Every visitor could be a future shop owner, know one, or refer one.
- Treat every conversation as a chance to make a good impression for Pivot Parlor.
- End every conversation on a positive note, even if the visitor is just browsing.

YOUR JOB — follow this flow naturally:
1. Find out if the visitor owns, manages, or knows someone who runs a beauty or barber shop.
2. If YES (they own or manage a shop): pitch Pivot Parlor in one sentence and ask one helpful follow-up question. Guide them to pivotparlor.com/contact to get started.
3. If they KNOW someone who owns a shop: warmly encourage them to share Pivot Parlor with that person. Give them something simple to share (e.g. "Tell them to check out pivotparlor.com — it could save them a lot of money every month.").
4. If they are JUST BROWSING or NOT a shop owner: be friendly and curious. Ask what brought them here. Always close with a warm invitation to share Pivot Parlor with anyone who runs a salon or barber shop.

REFERRAL MINDSET — always remember:
- Someone who is "just browsing" might have a friend, family member or colleague who owns a shop.
- A positive, warm conversation plants a seed. Be that seed.
- Never end with "this chat is for shop owners only." That is rude and closes doors.

KEY FACTS — only use what is relevant:
- £100 one-time setup fee. No monthly fees. 10% commission on completed bookings only.
- AI builds a fully branded booking website for the shop in 24 hours.
- Customers can book online 24/7. Staff scheduling and automated reminders included.
- Available for beauty parlours and barber shops across the UK.

RULES:
- No bullet points. No lists. Plain sentences only.
- No em-dashes. Use two sentences instead.
- No corporate language or filler words.
- Always be the most polite version of yourself, even if someone is dismissive or rude.`;

const PRIMARY_MODEL = "google/gemini-3.1-flash-lite-preview";
const FALLBACK_MODEL = "google/gemini-2.5-flash-lite";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
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
      max_tokens: 180,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${model} error: ${res.status} ${err}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error(`Empty response from ${model}`);
  return text;
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
  const env = context.env as { OPENROUTER_API_KEY?: string; KV?: KVNamespace };

  if (!env.OPENROUTER_API_KEY) {
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

  let body: { messages?: Array<{ role: string; content: string }> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const messages = body.messages ?? [];
  if (!messages.length) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  // The client only ever holds user/assistant turns — anything else (e.g. an
  // injected "system" row) is dropped, and each message is length-capped so a
  // hostile client cannot inflate prompt tokens. Newest 10 turns only.
  const safeMessages = messages
    .filter(
      (m): m is { role: string; content: string } =>
        !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-10);
  if (!safeMessages.length) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  try {
    const reply = await callOpenRouter(env.OPENROUTER_API_KEY, PRIMARY_MODEL, safeMessages);
    return Response.json({ reply, remaining });
  } catch (primaryErr) {
    console.warn("[api.chat] Primary model failed, trying fallback:", primaryErr);
    try {
      const reply = await callOpenRouter(env.OPENROUTER_API_KEY, FALLBACK_MODEL, safeMessages);
      return Response.json({ reply, remaining });
    } catch (fallbackErr) {
      console.error("[api.chat] Fallback model also failed:", fallbackErr);
      return Response.json({ error: "Chat unavailable. Please try again." }, { status: 502 });
    }
  }
}
