// Fixed-window KV rate limiter, moved with the public booking path from
// apps/worker/src/middleware/rate-limit.ts (WS-1).
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

type Ctx = Context<{ Bindings: Env }>;

export interface RateLimitOpts {
  /** Namespace for the KV key, e.g. "public-booking". */
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

/**
 * Fixed-window counter on KV. KV is eventually consistent across edge
 * locations, so this is an abuse brake, not a precise quota — bursts may
 * briefly exceed the limit. The window TTL is set on first increment.
 */
export function rateLimit(opts: RateLimitOpts): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const key = await opts.key(c as Ctx);
    if (key === null) {
      await next();
      return;
    }

    const kvKey = `rl:${opts.name}:${key}`;
    const raw = await c.env.KV.get(kvKey);
    const record = raw ? (JSON.parse(raw) as { n: number; resetAt: number }) : null;
    const now = Date.now();

    if (record && record.resetAt > now) {
      if (record.n >= opts.limit) {
        const retryAfterS = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
        c.header("Retry-After", String(retryAfterS));
        return c.json(
          { success: false, error: "Too many requests. Please try again later." },
          429
        );
      }
      await c.env.KV.put(
        kvKey,
        JSON.stringify({ n: record.n + 1, resetAt: record.resetAt }),
        { expirationTtl: Math.max(60, Math.ceil((record.resetAt - now) / 1000)) }
      );
    } else {
      await c.env.KV.put(
        kvKey,
        JSON.stringify({ n: 1, resetAt: now + opts.windowS * 1000 }),
        { expirationTtl: Math.max(60, opts.windowS) }
      );
    }

    await next();
  };
}
