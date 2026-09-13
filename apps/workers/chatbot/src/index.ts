import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ChatMessage } from "./types.js";
import type { Env } from "./types.js";
import { assertChatbotSchema } from "./ensure-schema.js";
import { generateReply } from "./llm.js";
import { CHATBOT_MODEL_KV_KEY, resolveChatbotModel } from "./model.js";
import { buildSystemPrompt, loadShopContext } from "./prompt.js";


// ─── Turnstile verification ───────────────────────────────────────────────────

async function verifyTurnstile(
  secretKey: string,
  token: string,
  ip: string
): Promise<boolean> {
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: ip }),
    });
    const data = await res.json<{ success: boolean }>();
    return data.success === true;
  } catch {
    return false;
  }
}

const FALLBACK_REPLY =
  "I'm having a quick moment — please try again or book directly at the link above.";

function platformReferralReply(shopSlug: string): string {
  return `Thanks for asking about how this site works. It runs on [Pivot Parlor](https://pivotparlor.com). If you want to book an appointment here, use [Book Now](/${shopSlug}/book).`;
}

function publicChatRateKeySuffixes(d = new Date()): { hourSuffix: string; daySuffix: string } {
  const iso = d.toISOString();
  const hourSuffix = `${iso.slice(0, 10)}-${iso.slice(11, 13)}`;
  const daySuffix = iso.slice(0, 10);
  return { hourSuffix, daySuffix };
}

const PUBLIC_CHAT_MAX_PER_HOUR = 50;
const PUBLIC_CHAT_MAX_PER_DAY = 200;

// Prompt-token cost is proportional to input size, so the visitor message and
// every history entry the client supplies are hard-capped (ABUSE-4: unbounded
// client history inflated the OpenRouter bill). 2,000 chars is far above any
// legitimate chat message.
const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_MESSAGES = 10;

// IP-scoped limit alongside the per-shop one: Turnstile gates bots, this stops
// one visitor (or one token-replaying script) draining a shop's shared quota.
const PUBLIC_CHAT_MAX_PER_IP_HOUR = 30;

async function tryConsumePublicChatRate(kv: KVNamespace, shopId: string, ip: string): Promise<boolean> {
  const { hourSuffix, daySuffix } = publicChatRateKeySuffixes();
  const hourKey = `rate:chat:${shopId}:hour:${hourSuffix}`;
  const dayKey = `rate:chat:${shopId}:day:${daySuffix}`;
  const ipKey = `rate:chat:ip:${ip}:hour:${hourSuffix}`;

  const [hourRaw, dayRaw, ipRaw] = await Promise.all([kv.get(hourKey), kv.get(dayKey), ip ? kv.get(ipKey) : Promise.resolve(null)]);
  const hourCount = Number(hourRaw ?? "0") || 0;
  const dayCount = Number(dayRaw ?? "0") || 0;
  const ipCount = Number(ipRaw ?? "0") || 0;

  if (
    hourCount >= PUBLIC_CHAT_MAX_PER_HOUR ||
    dayCount >= PUBLIC_CHAT_MAX_PER_DAY ||
    (ip !== "" && ipCount >= PUBLIC_CHAT_MAX_PER_IP_HOUR)
  ) {
    return false;
  }

  await Promise.all([
    kv.put(hourKey, String(hourCount + 1), { expirationTtl: 3600 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 86400 }),
    ...(ip !== "" ? [kv.put(ipKey, String(ipCount + 1), { expirationTtl: 3600 })] : []),
  ]);
  return true;
}

function isPlatformQuestion(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /how did you build (this )?(website|site)/.test(m) ||
    /how can i get a website like this/.test(m) ||
    /website like this/.test(m) ||
    /who made this (site|website)/.test(m) ||
    /booking page like this/.test(m) ||
    /system like this/.test(m) ||
    /want a (booking )?(page|system) like this/.test(m) ||
    /get (my |a |your )?own (booking )?(site|website|page)/.test(m) ||
    /how do i get a system like this/.test(m) ||
    /pivot parlor (platform|software)/.test(m)
  );
}

function appendPromoAwareness(base: string, promoActive: boolean): string {
  if (!promoActive) return base;
  return `${base}

PROMO AWARENESS: If the visitor asks about discounts, offers, promos, deals, or codes, explain the active promotion clearly and warmly.`;
}

const app = new Hono<{ Bindings: Env }>();

let schemaOnce: Promise<void> | null = null;
app.use("*", async (c, next) => {
  if (!schemaOnce) {
    // Clear on rejection — a cached rejected promise poisons every later request.
    schemaOnce = assertChatbotSchema(c.env.DB).catch((err) => {
      schemaOnce = null;
      throw err;
    });
  }
  await schemaOnce;
  await next();
});

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

const chat = new Hono<{ Bindings: Env }>();

/** Stateless chat for shop sites: `{ shopId, message, history }` → `{ reply }`. */
chat.post("/", async (c) => {
  const platformUrl = c.env.PLATFORM_URL || "https://pivotparlor.com";

  try {
    let body: { shopId?: string; message?: string; history?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ reply: FALLBACK_REPLY, error: "Invalid JSON" }, 400);
    }

    const shopId = typeof body.shopId === "string" ? body.shopId.trim() : "";
    const visitorMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!shopId || !visitorMessage) {
      return c.json({ reply: FALLBACK_REPLY, error: "shopId and message are required" }, 400);
    }
    if (visitorMessage.length > MAX_MESSAGE_CHARS) {
      return c.json({ reply: FALLBACK_REPLY, error: "Message too long" }, 400);
    }

    const ip = c.req.header("CF-Connecting-IP") ?? "";

    // Turnstile bot protection — only enforced when secret key is configured
    if (c.env.TURNSTILE_SECRET_KEY) {
      const turnstileToken = typeof (body as { turnstileToken?: string }).turnstileToken === "string"
        ? (body as { turnstileToken?: string }).turnstileToken!.trim()
        : "";
      if (!turnstileToken) {
        return c.json({ reply: FALLBACK_REPLY, error: "Security check required" }, 400);
      }
      const valid = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
      if (!valid) {
        return c.json({ reply: FALLBACK_REPLY, error: "Security check failed" }, 403);
      }
    }

    // History is client-supplied context: keep only the newest entries and
    // truncate each one, so a hostile client cannot inflate prompt tokens.
    const priorMessages: ChatMessage[] = [];
    if (Array.isArray(body.history)) {
      for (const item of body.history.slice(-MAX_HISTORY_MESSAGES)) {
        if (!item || typeof item !== "object") continue;
        const o = item as { role?: string; content?: string };
        if ((o.role === "user" || o.role === "assistant") && typeof o.content === "string") {
          priorMessages.push({ role: o.role, content: o.content.slice(0, MAX_MESSAGE_CHARS) });
        }
      }
    }

    const shop = await c.env.DB.prepare("SELECT id, name, type, slug FROM shops WHERE id = ? LIMIT 1")
      .bind(shopId)
      .first<{ id: string; name: string; type: string; slug: string }>();
    if (!shop) {
      return c.json({ reply: FALLBACK_REPLY, error: "Shop not found" }, 404);
    }

    const shopSlug = shop.slug;

    const allowed = await tryConsumePublicChatRate(c.env.KV, shop.id, ip);
    if (!allowed) {
      return c.json(
        { error: "rate_limit", message: "Too many messages. Please try again later." },
        429
      );
    }

    let reply: string;
    let answeredBy: { model: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } | null = null;

    if (isPlatformQuestion(visitorMessage)) {
      reply = platformReferralReply(shopSlug);
    } else {
      const ctx = await loadShopContext(c.env.DB, shop.id, shopSlug, shop.name, shop.type);
      let systemPrompt = appendPromoAwareness(buildSystemPrompt(ctx, platformUrl), ctx.promoActive);
      if (ctx.promoActive && /\b(discount|offer|promo|deal|code)\b/i.test(visitorMessage)) {
        systemPrompt = `${systemPrompt}\nThe visitor is asking about offers — reference the active promo if applicable.`;
      }

      // Platform-wide model choice (set on the developer dashboard); the code
      // default when unset or unreadable, logged once per request.
      const choice = resolveChatbotModel(await c.env.KV.get(CHATBOT_MODEL_KV_KEY));
      if (choice.source === "default" && choice.reason !== "unset") {
        console.warn(`[chatbot] platform model choice ignored (${choice.reason}); using ${choice.modelId}`);
      }

      const result = await generateReply({
        keys: {
          openrouter: c.env.OPENROUTER_API_KEY,
          openai: c.env.OPENAI_API_KEY || undefined,
          anthropic: c.env.ANTHROPIC_API_KEY || undefined,
        },
        modelId: choice.modelId,
        systemPrompt,
        history: priorMessages,
        userMessage: visitorMessage,
      });

      if (result.ok) {
        reply = result.content;
        answeredBy = { model: result.model, usage: result.usage };
      } else {
        reply = FALLBACK_REPLY;
      }
    }

    if (answeredBy) {
      const total = answeredBy.usage.total_tokens;
      const cost = total * 0.000000075;
      const logId = crypto.randomUUID();
      const jobRef = `public-chat:${logId}`;
      await c.env.DB.prepare(
        `INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, job_id)
         VALUES (?, ?, 'pivot-parlor-chatbot', ?, 'chatbot', ?, ?, ?, ?, ?)`
      )
        .bind(
          logId,
          shop.id,
          answeredBy.model,
          answeredBy.usage.prompt_tokens,
          answeredBy.usage.completion_tokens,
          total,
          cost,
          jobRef
        )
        .run();
    }

    return c.json({ reply });
  } catch (e) {
    console.error("[chatbot] public /chat error", e);
    return c.json({ reply: FALLBACK_REPLY, error: "Something went wrong" }, 500);
  }
});

app.route("/chat", chat);

app.get("/health", (c) => c.json({ ok: true, worker: "pivot-parlor-chatbot" }));

export default app;
