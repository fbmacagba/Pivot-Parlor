import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  OPENROUTER_API_KEY: string;
  ENVIRONMENT: string;
  PLATFORM_URL: string;
  TURNSTILE_SECRET_KEY?: string;
};

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export const OPENROUTER_MODEL = "google/gemini-3.1-flash-lite-preview" as const;
