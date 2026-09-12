import type { Route } from "./ids";

export class LlmError extends Error {
  readonly route: Route;
  readonly model: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(opts: { route: Route; model: string; status?: number; retryable: boolean; message: string }) {
    super(opts.message);
    this.name = "LlmError";
    this.route = opts.route;
    this.model = opts.model;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
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

export function noContentError(route: Route, model: string, status: number, body: string): LlmError {
  return new LlmError({
    route,
    model,
    status,
    retryable: false,
    message: `${route}/${model}: HTTP ${status} no content ${shortBody(body)}`.trimEnd(),
  });
}
