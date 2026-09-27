import type { D1Database, KVNamespace, R2Bucket, Queue, Fetcher } from "@cloudflare/workers-types";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: R2Bucket;
  /** Append-only audit archive (retention-locked bucket, spec 5.2). */
  AUDIT_ARCHIVE: R2Bucket;
  /** Service binding to pivot-parlor-booking — the canonical booking system (WS-1).
   *  Public /api/bookings and /api/shops/:shopId/slots proxy through it. */
  BOOKING: Fetcher;
  /** Booking reminder queue (legacy) */
  QUEUE?: Queue;
  site_research_queue?: Queue;
  JWT_SECRET: string;
  OPENROUTER_API_KEY: string;
  /** Direct-vendor keys (spec 2026-09-12 multi-provider LLM). Optional: a missing key hides that provider group. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_AI_API_KEY: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ENVIRONMENT?: string;
  /** "true" enables E2E mock/fixture request paths. Dev/staging only — never set in production. */
  E2E_FIXTURES?: string;
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
