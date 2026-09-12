import type { Route } from "./ids";

export type Effort = "low" | "medium" | "high";

export interface ProviderKeys {
  openrouter?: string;
  openai?: string;
  anthropic?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** Route-qualified id (see parseModelId). */
  modelId: string;
  system?: string;
  messages: ChatMessage[];
  effort?: Effort;
  /** Requested output budget; clamped by maxOutputTokensFor. */
  maxTokens: number;
  /** Ask for a JSON object and return only the first balanced object. */
  jsonOnly?: boolean;
  signal?: AbortSignal;
  /** Retries on 429 / 5xx / network errors (default 3: 3 s, 6 s, 9 s back-off). */
  maxRetries?: number;
  /** OpenRouter X-Title header (default "Pivot Parlor"). */
  appTitle?: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage | null;
  /** What was actually called. */
  route: Route;
  model: string;
}

/** Injection points for tests (real fetch and setTimeout by default). */
export interface ChatDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Everything an adapter needs; `model` is the vendor id / OpenRouter slug. */
export interface AdapterRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  effort?: Effort;
  maxTokens: number;
  jsonOnly: boolean;
  signal?: AbortSignal;
  appTitle: string;
}

export interface AdapterResponse {
  text: string;
  usage: ChatUsage | null;
}

export interface Adapter {
  route: Route;
  buildRequest(req: AdapterRequest, apiKey: string): { url: string; init: RequestInit };
  /** null when the body carries no usable text. */
  parseResponse(body: unknown): AdapterResponse | null;
  /** True when a 400 body is complaining about the effort parameter. */
  isEffortRejection(body: string): boolean;
}
