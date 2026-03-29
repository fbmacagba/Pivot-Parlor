import type { D1Database, KVNamespace, R2Bucket, Queue } from "@cloudflare/workers-types";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: R2Bucket;
  /** Booking reminder queue (legacy) */
  QUEUE?: Queue;
  site_research_queue?: Queue;
  JWT_SECRET: string;
  OPENROUTER_API_KEY: string;
  GOOGLE_AI_API_KEY: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ENVIRONMENT?: string;
  ASSET_BASE_URL?: string;
  APP_URL?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  FACEBOOK_OAUTH_APP_ID?: string;
  FACEBOOK_OAUTH_APP_SECRET?: string;
  LINKEDIN_OAUTH_CLIENT_ID?: string;
  LINKEDIN_OAUTH_CLIENT_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
};
