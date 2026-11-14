import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ChatMessage } from "./types.js";
import type { Env } from "./types.js";
import { AuditWriteError, auditAiCall } from "@repo/audit";
import { recordAiUsage } from "@repo/llm";
import { AUDIT_REFUSED_MESSAGE, ChatReplyFailedError, WORKER_NAME, auditFor } from "./audit.js";
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
  "I'm having a quick moment. Please try again, or book directly at the link above.";

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

// All shops together, per UTC day. The limits above each stop one source, but
// without this the most a day of chat can cost grows with the number of shops.
// KV is eventually consistent, so like the others this is a brake, not an
// exact quota.
const PUBLIC_CHAT_MAX_PLATFORM_PER_DAY = 1_000;

type ChatRateVerdict = "allowed" | "limited" | "platform_cap";

async function tryConsumePublicChatRate(kv: KVNamespace, shopId: string, ip: string): Promise<ChatRateVerdict> {
  const { hourSuffix, daySuffix } = publicChatRateKeySuffixes();
  const hourKey = `rate:chat:${shopId}:hour:${hourSuffix}`;
  const dayKey = `rate:chat:${shopId}:day:${daySuffix}`;
  const ipKey = `rate:chat:ip:${ip}:hour:${hourSuffix}`;
  const platformKey = `rate:chat:platform:day:${daySuffix}`;

  const [hourRaw, dayRaw, ipRaw, platformRaw] = await Promise.all([
    kv.get(hourKey),
    kv.get(dayKey),
    ip ? kv.get(ipKey) : Promise.resolve(null),
    kv.get(platformKey),
  ]);
  const hourCount = Number(hourRaw ?? "0") || 0;
  const dayCount = Number(dayRaw ?? "0") || 0;
  const ipCount = Number(ipRaw ?? "0") || 0;
  const platformCount = Number(platformRaw ?? "0") || 0;

  if (platformCount >= PUBLIC_CHAT_MAX_PLATFORM_PER_DAY) return "platform_cap";
  if (
    hourCount >= PUBLIC_CHAT_MAX_PER_HOUR ||
    dayCount >= PUBLIC_CHAT_MAX_PER_DAY ||
    (ip !== "" && ipCount >= PUBLIC_CHAT_MAX_PER_IP_HOUR)
  ) {
    return "limited";
  }

  await Promise.all([
    kv.put(hourKey, String(hourCount + 1), { expirationTtl: 3600 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 86400 }),
    ...(ip !== "" ? [kv.put(ipKey, String(ipCount + 1), { expirationTtl: 3600 })] : []),
    kv.put(platformKey, String(platformCount + 1), { expirationTtl: 86400 }),
  ]);
  return "allowed";
}

/**
 * Tells the owner (Workers Issues emails on console.error) the first time each
 * UTC day that the platform cap turns a visitor away. The message is constant
 * and carries no visitor data, so every day's alert lands in one issue.
 */
async function reportPlatformCapOnce(kv: KVNamespace): Promise<void> {
  const flagKey = `alert:chat:platform-cap:${publicChatRateKeySuffixes().daySuffix}`;
  if (await kv.get(flagKey)) return;
  await kv.put(flagKey, "1", { expirationTtl: 86400 });
  console.error(
    `[chatbot] platform chat cap reached: ${PUBLIC_CHAT_MAX_PLATFORM_PER_DAY} replies today (UTC); visitors are refused until midnight UTC`
  );
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
    // A body that is not a JSON object (not JSON, or null, an array, a number,
    // a string) is the sender's mistake: a 400 before anything reads a field,
    // never the catch's 500 below. (The same rule as readJsonObject in
    // @repo/utils, written out here so this worker takes no new dependency.)
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ reply: FALLBACK_REPLY, error: "Invalid JSON" }, 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ reply: FALLBACK_REPLY, error: "Invalid JSON" }, 400);
    }
    const body = parsed as { shopId?: unknown; message?: unknown; history?: unknown; turnstileToken?: unknown };

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
      const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
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

    // The shop, and the status of its published site, in one read. The public
    // sees a shop's site, and so its chat, only when that site is live: the
    // site layout ($shopSlug.tsx) answers 404 for a draft, 503 for a paused
    // site, and "Coming Soon" with no chat when nothing is published. Every
    // other case is refused exactly like an unknown shop, before anything is
    // spent or counted.
    const shop = await c.env.DB.prepare(
      "SELECT id, name, type, slug, (SELECT website_status FROM shop_sites WHERE shop_sites.shop_id = shops.id AND shop_sites.status = 'active' LIMIT 1) AS website_status FROM shops WHERE id = ? LIMIT 1"
    )
      .bind(shopId)
      .first<{ id: string; name: string; type: string; slug: string; website_status: string | null }>();
    if (!shop || (shop.website_status ?? "").toLowerCase() !== "live") {
      return c.json({ reply: FALLBACK_REPLY, error: "Shop not found" }, 404);
    }

    const shopSlug = shop.slug;

    const verdict = await tryConsumePublicChatRate(c.env.KV, shop.id, ip);
    if (verdict !== "allowed") {
      if (verdict === "platform_cap") await reportPlatformCapOnce(c.env.KV);
      return c.json(
        { error: "rate_limit", message: "Too many messages. Please try again later." },
        429
      );
    }

    let reply: string;

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

      // One audited ai.call per model reply. The entry and the usage row share
      // this id (the row's job_id is `public-chat:<requestId>`).
      const requestId = crypto.randomUUID();
      const rec = auditFor(c.env, c.req.header("CF-Connecting-IP") ?? null, requestId);

      try {
        const answered = await auditAiCall(
          rec,
          { purpose: "chatbot", model: choice.modelId, shopId: shop.id, origin: null },
          async () => {
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
            if (!result.ok) throw new ChatReplyFailedError();
            const cost = await recordAiUsage(c.env, {
              shopId: shop.id,
              workerName: WORKER_NAME,
              modelId: result.model,
              usageType: "chatbot",
              usage: result.rawUsage,
              jobId: `public-chat:${requestId}`,
            });
            return { result, cost };
          },
          ({ result, cost }) => ({
            model: result.model,
            route: result.route,
            inputTokens: result.rawUsage?.inputTokens ?? null,
            outputTokens: result.rawUsage?.outputTokens ?? null,
            costUsd: cost?.costUsd ?? null,
            costBasis: cost?.basis ?? null,
          })
        );
        reply = answered.result.content;
      } catch (err) {
        if (!(err instanceof ChatReplyFailedError)) throw err;
        reply = FALLBACK_REPLY;
      }
    }

    return c.json({ reply });
  } catch (e) {
    if (e instanceof AuditWriteError) {
      console.error("[chatbot] audit write refused; answered 503", e);
      return c.json({ reply: FALLBACK_REPLY, error: AUDIT_REFUSED_MESSAGE }, 503);
    }
    console.error("[chatbot] public /chat error", e);
    return c.json({ reply: FALLBACK_REPLY, error: "Something went wrong" }, 500);
  }
});

app.route("/chat", chat);

app.get("/health", (c) => c.json({ ok: true, worker: "pivot-parlor-chatbot" }));

export default app;
