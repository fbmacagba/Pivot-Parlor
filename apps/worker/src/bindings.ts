import type { D1Database, KVNamespace, R2Bucket, Queue } from "@cloudflare/workers-types";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: R2Bucket;
  /** Booking reminder queue (legacy) */
  QUEUE?: Queue;
  site_research_queue?: Queue;
  site_build_queue?: Queue;
  site_audit_queue?: Queue;
  JWT_SECRET: string;
  OPENROUTER_API_KEY: string;
  GOOGLE_AI_API_KEY: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ENVIRONMENT?: string;
  ASSET_BASE_URL?: string;
};
