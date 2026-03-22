import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  ENVIRONMENT: string;
  PLATFORM_URL: string;
};

export interface JWTUser {
  sub: string;
  role: string;
  shop_id?: string;
  shop_slug?: string;
  exp: number;
}
