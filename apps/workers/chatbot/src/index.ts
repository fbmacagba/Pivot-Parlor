import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ChatMessage } from "./types.js";
import type { Env } from "./types.js";
import { OPENROUTER_MODEL } from "./types.js";
import { ensureChatbotSchema } from "./ensure-schema.js";
import { buildQuickReplies } from "./quick-replies.js";
import { callOpenRouter } from "./openrouter.js";
import {
  buildSystemPrompt,
  loadShopContext,
  welcomeMessage as buildWelcomeMessage,
} from "./prompt.js";


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

function jsonError(c: { json: (b: unknown, s: number) => Response }, status: number, error: string) {
  return c.json({ success: false, error }, status);
}

function parseMessages(raw: string): ChatMessage[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: ChatMessage[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as { role?: string; content?: string };
      if ((o.role === "user" || o.role === "assistant") && typeof o.content === "string") {
        out.push({ role: o.role, content: o.content });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function serializeMessages(messages: ChatMessage[]): string {
  return JSON.stringify(messages);
}

function rateLimitKey(shopSlug: string): string {
  const hour = new Date().toISOString().slice(0, 13);
  return `ratelimit:chat:${shopSlug}:${hour}`;
}

function publicChatRateKeySuffixes(d = new Date()): { hourSuffix: string; daySuffix: string } {
  const iso = d.toISOString();
  const hourSuffix = `${iso.slice(0, 10)}-${iso.slice(11, 13)}`;
  const daySuffix = iso.slice(0, 10);
  return { hourSuffix, daySuffix };
}

const PUBLIC_CHAT_MAX_PER_HOUR = 50;
const PUBLIC_CHAT_MAX_PER_DAY = 200;

async function tryConsumePublicChatRate(kv: KVNamespace, shopId: string): Promise<boolean> {
  const { hourSuffix, daySuffix } = publicChatRateKeySuffixes();
  const hourKey = `rate:chat:${shopId}:hour:${hourSuffix}`;
  const dayKey = `rate:chat:${shopId}:day:${daySuffix}`;

  const [hourRaw, dayRaw] = await Promise.all([kv.get(hourKey), kv.get(dayKey)]);
  const hourCount = Number(hourRaw ?? "0") || 0;
  const dayCount = Number(dayRaw ?? "0") || 0;

  if (hourCount >= PUBLIC_CHAT_MAX_PER_HOUR || dayCount >= PUBLIC_CHAT_MAX_PER_DAY) {
    return false;
  }

  await Promise.all([
    kv.put(hourKey, String(hourCount + 1), { expirationTtl: 3600 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 86400 }),
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

function signalsBookingIntent(text: string, shopSlug: string, platformHost: string): boolean {
  const bookUrl = `${platformHost.replace(/\/$/, "")}/${shopSlug}#book`;
  return (
    text.includes("#book") ||
    text.includes(bookUrl) ||
    /pivotparlor\.com\/[^)\s]+#book/.test(text) ||
    /\b(book (now|here|online)|book an appointment|reserve (a |your )?slot)\b/i.test(text)
  );
}

function appendPromoAwareness(base: string, promoActive: boolean): string {
  if (!promoActive) return base;
  return `${base}

PROMO AWARENESS: If the visitor asks about discounts, offers, promos, deals, or codes, explain the active promotion clearly and warmly.`;
}

/** Returns true if the service name looks like a retail product. */
function looksLikeProduct(name: string, category: string | null): boolean {
  if (category?.toLowerCase() === "product") return true;
  return /\b(shampoo|conditioner|pomade|wax|gel|oil|serum|cream|balm|spray|tonic|beard|hair product|grooming kit|aftershave|moisturiser|moisturizer|clay|paste|putty|powder|treatment kit|retail)\b/i.test(name);
}

const app = new Hono<{ Bindings: Env }>();

let schemaOnce: Promise<void> | null = null;
app.use("*", async (c, next) => {
  if (!schemaOnce) {
    // Clear on rejection — a cached rejected promise poisons every later request.
    schemaOnce = ensureChatbotSchema(c.env.DB).catch((err) => {
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

    // Turnstile bot protection — only enforced when secret key is configured
    if (c.env.TURNSTILE_SECRET_KEY) {
      const turnstileToken = typeof (body as { turnstileToken?: string }).turnstileToken === "string"
        ? (body as { turnstileToken?: string }).turnstileToken!.trim()
        : "";
      if (!turnstileToken) {
        return c.json({ reply: FALLBACK_REPLY, error: "Security check required" }, 400);
      }
      const ip = c.req.header("CF-Connecting-IP") ?? "";
      const valid = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
      if (!valid) {
        return c.json({ reply: FALLBACK_REPLY, error: "Security check failed" }, 403);
      }
    }

    const priorMessages: ChatMessage[] = [];
    if (Array.isArray(body.history)) {
      for (const item of body.history) {
        if (!item || typeof item !== "object") continue;
        const o = item as { role?: string; content?: string };
        if ((o.role === "user" || o.role === "assistant") && typeof o.content === "string") {
          priorMessages.push({ role: o.role, content: o.content });
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

    const allowed = await tryConsumePublicChatRate(c.env.KV, shop.id);
    if (!allowed) {
      return c.json(
        { error: "rate_limit", message: "Too many messages. Please try again later." },
        429
      );
    }

    let reply: string;
    let usedOpenRouter = false;
    let usageForLog: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

    if (isPlatformQuestion(visitorMessage)) {
      reply = platformReferralReply(shopSlug);
    } else {
      usedOpenRouter = true;
      const ctx = await loadShopContext(c.env.DB, shop.id, shopSlug, shop.name, shop.type);
      let systemPrompt = appendPromoAwareness(buildSystemPrompt(ctx, platformUrl), ctx.promoActive);
      if (ctx.promoActive && /\b(discount|offer|promo|deal|code)\b/i.test(visitorMessage)) {
        systemPrompt = `${systemPrompt}\nThe visitor is asking about offers — reference the active promo if applicable.`;
      }

      const or = await callOpenRouter({
        apiKey: c.env.OPENROUTER_API_KEY,
        systemPrompt,
        history: priorMessages,
        userMessage: visitorMessage,
        referer: "https://pivotparlor.com",
        title: "Pivot Parlor Chatbot",
      });

      if (or.ok) {
        reply = or.content;
        usageForLog = or.usage;
      } else {
        reply = FALLBACK_REPLY;
      }
    }

    if (usedOpenRouter && usageForLog) {
      const total = usageForLog.total_tokens;
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
          OPENROUTER_MODEL,
          usageForLog.prompt_tokens,
          usageForLog.completion_tokens,
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

chat.post("/:shopSlug/session", async (c) => {
  try {
    const shopSlug = c.req.param("shopSlug");
    let body: { visitorId?: string };
    try {
      body = (await c.req.json()) as { visitorId?: string };
    } catch {
      return jsonError(c, 400, "Invalid JSON");
    }
    const visitorId = typeof body.visitorId === "string" ? body.visitorId.trim() : "";
    if (!visitorId) {
      return jsonError(c, 400, "visitorId is required");
    }

    const shop = await c.env.DB.prepare("SELECT id, name, type FROM shops WHERE slug = ? LIMIT 1")
      .bind(shopSlug)
      .first<{ id: string; name: string; type: string }>();
    if (!shop) {
      return jsonError(c, 404, "Shop not found");
    }

    // Fetch site, settings, and services in parallel
    const [site, settings, servicesRes] = await Promise.all([
      c.env.DB.prepare("SELECT logo_url FROM shop_sites WHERE shop_id = ? LIMIT 1")
        .bind(shop.id)
        .first<{ logo_url: string | null }>(),
      c.env.DB
        .prepare(
          "SELECT promo_active, promo_discount_code, promo_discount_percent FROM shop_settings WHERE shop_id = ? LIMIT 1"
        )
        .bind(shop.id)
        .first<{
          promo_active: number | null;
          promo_discount_code: string | null;
          promo_discount_percent: number | null;
        }>(),
      c.env.DB
        .prepare(
          "SELECT name, price, category FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY name ASC"
        )
        .bind(shop.id)
        .all<{ name: string; price: number; category: string | null }>(),
    ]);

    // Separate treatments from products
    const allServices: { name: string; price: number; category: string | null }[] =
      (servicesRes.results ?? []) as { name: string; price: number; category: string | null }[];
    const treatmentServices = allServices.filter(s => !looksLikeProduct(s.name, s.category));
    const hasProducts = allServices.some(s => looksLikeProduct(s.name, s.category));

    const promoActive = Number(settings?.promo_active ?? 0) === 1;
    const promoDiscountPercent = Math.round(Number(settings?.promo_discount_percent ?? 0));
    const promoDiscountCode = settings?.promo_discount_code?.trim() ?? "";

    const sessionId = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO chat_sessions (id, shop_id, visitor_id, messages_json, booking_initiated, created_at, updated_at)
         VALUES (?, ?, ?, '[]', 0, datetime('now'), datetime('now'))`
      )
      .bind(sessionId, shop.id, visitorId)
      .run();

    // Build welcome message with services snapshot and product awareness
    const welcome = buildWelcomeMessage(
      shop.name,
      promoActive,
      promoDiscountPercent,
      promoDiscountCode,
      treatmentServices,
      hasProducts
    );

    return c.json({
      success: true,
      sessionId,
      shopName: shop.name,
      shopAvatar: site?.logo_url ?? null,
      welcomeMessage: welcome,
    });
  } catch (e) {
    console.error("[chatbot] session error", e);
    return jsonError(c, 500, "Something went wrong");
  }
});

chat.post("/:shopSlug/message", async (c) => {
  const platformUrl = c.env.PLATFORM_URL || "https://pivotparlor.com";
  const bookingUrl = `${platformUrl.replace(/\/$/, "")}/${c.req.param("shopSlug")}#book`;

  try {
    const shopSlug = c.req.param("shopSlug");

    let body: { sessionId?: string; visitorId?: string; message?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return jsonError(c, 400, "Invalid JSON");
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const visitorId = typeof body.visitorId === "string" ? body.visitorId.trim() : "";
    const visitorMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!sessionId || !visitorId || !visitorMessage) {
      return jsonError(c, 400, "sessionId, visitorId, and message are required");
    }

    const shop = await c.env.DB.prepare("SELECT id, name, type FROM shops WHERE slug = ? LIMIT 1")
      .bind(shopSlug)
      .first<{ id: string; name: string; type: string }>();
    if (!shop) {
      return jsonError(c, 404, "Shop not found");
    }

    const session = await c.env.DB.prepare(
      "SELECT id, shop_id, visitor_id, messages_json, booking_initiated FROM chat_sessions WHERE id = ? LIMIT 1"
    )
      .bind(sessionId)
      .first<{
        id: string;
        shop_id: string;
        visitor_id: string;
        messages_json: string;
        booking_initiated: number;
      }>();

    if (!session || session.shop_id !== shop.id || session.visitor_id !== visitorId) {
      return jsonError(c, 403, "Invalid session");
    }

    const rlKey = rateLimitKey(shopSlug);
    const current = Number((await c.env.KV.get(rlKey)) ?? "0");
    if (current >= 100) {
      return c.json(
        {
          success: false,
          error: "This chat is temporarily busy. Please try again shortly or book directly.",
        },
        429
      );
    }
    await c.env.KV.put(rlKey, String(current + 1), { expirationTtl: 7200 });

    const priorMessages = parseMessages(session.messages_json);

    const messages: ChatMessage[] = [...priorMessages, { role: "user", content: visitorMessage }];

    let reply: string;
    let usedOpenRouter = false;
    let usageForLog: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

    if (isPlatformQuestion(visitorMessage)) {
      reply = platformReferralReply(shopSlug);
    } else {
      usedOpenRouter = true;
      const ctx = await loadShopContext(c.env.DB, shop.id, shopSlug, shop.name, shop.type);
      let systemPrompt = appendPromoAwareness(buildSystemPrompt(ctx, platformUrl), ctx.promoActive);
      if (
        ctx.promoActive &&
        /\b(discount|offer|promo|deal|code)\b/i.test(visitorMessage)
      ) {
        systemPrompt = `${systemPrompt}\nThe visitor is asking about offers — reference the active promo if applicable.`;
      }

      const or = await callOpenRouter({
        apiKey: c.env.OPENROUTER_API_KEY,
        systemPrompt,
        history: priorMessages,
        userMessage: visitorMessage,
        referer: "https://pivotparlor.com",
        title: "Pivot Parlor Chatbot",
      });

      if (or.ok) {
        reply = or.content;
        usageForLog = or.usage;
      } else {
        reply = FALLBACK_REPLY;
      }
    }

    const assistantMsg: ChatMessage = { role: "assistant", content: reply };
    messages.push(assistantMsg);

    const bookingHit =
      Number(session.booking_initiated) === 1 || signalsBookingIntent(reply, shopSlug, platformUrl);

    const bookingInitiated = bookingHit || Number(session.booking_initiated) === 1 ? 1 : 0;

    await c.env.DB
      .prepare(
        `UPDATE chat_sessions SET messages_json = ?, updated_at = datetime('now'), booking_initiated = ? WHERE id = ?`
      )
      .bind(serializeMessages(messages), bookingInitiated, sessionId)
      .run();

    if (usedOpenRouter && usageForLog) {
      const total = usageForLog.total_tokens;
      const cost = total * 0.000000075;
      const logId = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, job_id)
         VALUES (?, ?, 'pivot-parlor-chatbot', ?, 'chatbot', ?, ?, ?, ?, ?)`
      )
        .bind(
          logId,
          shop.id,
          OPENROUTER_MODEL,
          usageForLog.prompt_tokens,
          usageForLog.completion_tokens,
          total,
          cost,
          sessionId
        )
        .run();
    }

    const quickReplies = buildQuickReplies(priorMessages, reply);

    return c.json({
      success: true,
      reply,
      quickReplies,
      bookingUrl,
    });
  } catch (e) {
    console.error("[chatbot] message error", e);
    return c.json(
      {
        success: false,
        error: "Something went wrong",
        reply: FALLBACK_REPLY,
        quickReplies: buildQuickReplies([], ""),
        bookingUrl,
      },
      500
    );
  }
});

chat.get("/:shopSlug/health", (c) =>
  c.json({ ok: true, worker: "pivot-parlor-chatbot", shopSlug: c.req.param("shopSlug") })
);

app.route("/chat", chat);

app.get("/health", (c) => c.json({ ok: true, worker: "pivot-parlor-chatbot" }));

export default app;
