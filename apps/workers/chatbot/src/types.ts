import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  OPENROUTER_API_KEY: string;
  /** Direct-vendor keys; optional. A platform choice on a route with no key falls back to the default model. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENVIRONMENT: string;
  PLATFORM_URL: string;
  TURNSTILE_SECRET_KEY?: string;
};

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
