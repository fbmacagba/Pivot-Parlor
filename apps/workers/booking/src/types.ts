import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";

export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  ENVIRONMENT: string;
  PLATFORM_URL: string;
  /** Reminder queue producer (pivot-parlor-reminders); consumer stays in the main worker. */
  QUEUE?: Queue;
  /** Resend key for booking confirmation emails (wrangler secret). */
  RESEND_API_KEY?: string;
  /** Signing secret of this worker's Stripe webhook endpoint (wrangler secret). */
  STRIPE_WEBHOOK_SECRET?: string;
};

export interface JWTUser {
  sub: string;
  role: string;
  shop_id?: string;
  shop_slug?: string;
  exp: number;
}
