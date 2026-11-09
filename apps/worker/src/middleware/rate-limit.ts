import type { Context, MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings.js";

type Ctx = Context<{ Bindings: Bindings }>;

export interface RateLimitOpts {
  /** Namespace for the KV key, e.g. "login". */
  name: string;
  /** Max requests per window. */
  limit: number;
  /** Window in seconds. KV's minimum TTL is 60. */
  windowS: number;
  /**
   * Request → limit key (e.g. ip, user id, email+ip). Return null to skip
   * limiting for this request.
   */
  key: (c: Ctx) => Promise<string | null> | string | null;
}

export function clientIp(c: Ctx): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

export type WindowSlot = { ok: true; remaining: number } | { ok: false; retryAfterS: number };

/**
 * Take one slot from a fixed-window counter on KV. A full window takes
 * nothing and answers when it resets; otherwise `remaining` is the slots left
 * after this one. KV is eventually consistent across edge locations, so this
 * is an abuse brake, not a precise quota — bursts may briefly exceed the
 * limit. The window TTL is set on first increment.
 */
export async function takeWindowSlot(kv: KVNamespace, kvKey: string, limit: number, windowS: number): Promise<WindowSlot> {
  const raw = await kv.get(kvKey);
  const record = raw ? (JSON.parse(raw) as { n: number; resetAt: number }) : null;
  const now = Date.now();

  if (record && record.resetAt > now) {
    if (record.n >= limit) {
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((record.resetAt - now) / 1000)) };
    }
    await kv.put(
      kvKey,
      JSON.stringify({ n: record.n + 1, resetAt: record.resetAt }),
      { expirationTtl: Math.max(60, Math.ceil((record.resetAt - now) / 1000)) }
    );
    return { ok: true, remaining: limit - (record.n + 1) };
  }
  await kv.put(
    kvKey,
    JSON.stringify({ n: 1, resetAt: now + windowS * 1000 }),
    { expirationTtl: Math.max(60, windowS) }
  );
  return { ok: true, remaining: limit - 1 };
}

/** Per-request rate limit over `takeWindowSlot`: a full window answers 429. */
export function rateLimit(opts: RateLimitOpts): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const key = await opts.key(c as Ctx);
    if (key === null) {
      await next();
      return;
    }

    const slot = await takeWindowSlot(c.env.KV, `rl:${opts.name}:${key}`, opts.limit, opts.windowS);
    if (!slot.ok) {
      c.header("Retry-After", String(slot.retryAfterS));
      return c.json(
        { success: false, error: "Too many requests. Please try again later." },
        429
      );
    }

    await next();
  };
}
