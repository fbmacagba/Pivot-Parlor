import type { Route } from "./ids";
import type { ChatUsage } from "./types";

export class LlmError extends Error {
  readonly route: Route;
  readonly model: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /**
   * Tokens the provider billed for a call that still failed: set only when a
   * 200 came back with no usable text (a reasoning model that spent its whole
   * budget thinking). Null for every other failure.
   */
  readonly usage: ChatUsage | null;

  constructor(opts: {
    route: Route;
    model: string;
    status?: number;
    retryable: boolean;
    message: string;
    usage?: ChatUsage | null;
  }) {
    super(opts.message);
    this.name = "LlmError";
    this.route = opts.route;
    this.model = opts.model;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.usage = opts.usage ?? null;
  }
}

/** The billed tokens of a failed call, or null when the failure was not one the provider billed. */
export function billedUsageOf(err: unknown): ChatUsage | null {
  return err instanceof LlmError ? err.usage : null;
}

function shortBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function httpError(route: Route, model: string, status: number, body: string): LlmError {
  return new LlmError({
    route,
    model,
    status,
    retryable: status === 429 || status >= 500,
    message: `${route}/${model}: HTTP ${status} ${shortBody(body)}`.trimEnd(),
  });
}

export function networkError(route: Route, model: string, err: unknown): LlmError {
  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError({ route, model, retryable: true, message: `${route}: ${msg}` });
}

export function abortedError(route: Route, model: string): LlmError {
  return new LlmError({ route, model, retryable: false, message: `${route}: aborted` });
}

export function missingKeyError(route: Route, model: string): LlmError {
  return new LlmError({ route, model, retryable: false, message: `${route}: API key not configured` });
}

export function noContentError(
  route: Route,
  model: string,
  status: number,
  body: string,
  usage: ChatUsage | null = null
): LlmError {
  return new LlmError({
    route,
    model,
    status,
    retryable: false,
    message: `${route}/${model}: HTTP ${status} no content ${shortBody(body)}`.trimEnd(),
    usage,
  });
}
