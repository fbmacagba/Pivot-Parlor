/**
 * The load context every loader and action gets: the same on Pages
 * (functions/_middleware.ts) and in dev (vite.config.ts).
 *
 * It is built from `context.cloudflare`, which both Remix 2 and React Router 7
 * hand to `getLoadContext`. Remix 2 also spread the Pages event at the top
 * level, but marked it deprecated, and React Router 7 dropped it; reading it
 * there would leave every loader without `env`.
 */

/** The part of `context.cloudflare` the website uses. */
export interface CloudflareRequestContext {
  env: Record<string, unknown>;
  ctx: { waitUntil(promise: Promise<unknown>): void };
  /** The Pages event's `data`; the middleware puts the CSP nonce here. */
  data?: Record<string, unknown>;
}

// A type alias, not an interface: the router's AppLoadContext is an open
// record ({ [key: string]: unknown }), which an interface does not satisfy.
export type WebLoadContext = {
  env: Record<string, unknown>;
  /** Keeps work (an error report) alive after the response is sent. */
  waitUntil(promise: Promise<unknown>): void;
  /** This response's CSP nonce, for the render's inline scripts. None in dev. */
  cspNonce?: string;
};

export function webLoadContext(cloudflare: CloudflareRequestContext): WebLoadContext {
  const nonce = cloudflare.data?.cspNonce;
  return {
    env: cloudflare.env,
    waitUntil: (promise) => cloudflare.ctx.waitUntil(promise),
    cspNonce: typeof nonce === "string" ? nonce : undefined,
  };
}
