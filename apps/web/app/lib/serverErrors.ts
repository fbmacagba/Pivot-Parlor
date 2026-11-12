/**
 * Website server errors reach the owner's alert email.
 *
 * Pages Functions have no Workers Logs or Issues, so an error in a loader, an
 * action or the server render used to reach nobody. Each one is now handed to
 * the API worker's WebErrors entrypoint (apps/worker/src/web-errors.ts) over
 * the WEB_ERRORS service binding (apps/web/wrangler.toml); its log line is
 * what Workers Issues turns into an email.
 *
 * What is sent: where it failed, the method, the route with every value
 * replaced by its parameter name, the error type, the message with emails,
 * ids, tokens and long numbers masked, and the top stack lines without file
 * paths. Never the query string, headers, cookies, form contents or the user.
 * The API masks again and rate-limits; a visitor who left, a thrown Response
 * (a deliberate redirect, 404 or 403) and Remix's own not-found are skipped.
 */
import type { HandleErrorFunction } from "@remix-run/cloudflare";
import { scrubErrorText } from "@repo/utils";

export type ErrorWhere = "page" | "data" | "action" | "render" | "middleware";

/** The shape apps/worker/src/web-errors.ts accepts. */
export interface WebErrorReport {
  where: ErrorWhere;
  method: string;
  route: string;
  name: string;
  message: string;
  frames: string[];
}

export interface WebErrorsBinding {
  report(report: WebErrorReport): Promise<unknown> | unknown;
}

export interface ReportOptions {
  request: Request;
  params?: Record<string, string | undefined>;
  /** Defaults to the request: page, data or action. */
  where?: ErrorWhere;
  env?: { WEB_ERRORS?: WebErrorsBinding };
  /** Keeps the report alive after the response is sent. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

const MAX_FRAMES = 5;

// Segments that carry a value rather than name a page, for routes with no
// parameters to go by (the middleware runs before Remix matches a route).
const ID_LIKE =
  /^(?:\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,})$/i;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** "/book/ferdym" with { shopSlug: "ferdym" } becomes "/book/:shopSlug". */
export function routePattern(pathname: string, params: Record<string, string | undefined> = {}): string {
  let segments = pathname.split("/");
  const decoded = segments.map(decodeSegment);

  const splat = params["*"];
  if (splat) {
    const tail = splat.split("/");
    const start = decoded.length - tail.length;
    if (start > 0 && tail.every((part, i) => decoded[start + i] === part)) {
      segments = [...segments.slice(0, start), "*"];
    }
  }

  const nameOf = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    if (name !== "*" && value) nameOf.set(value, name);
  }

  const pattern = segments
    .map((segment, i) => {
      if (segment === "*" || segment === "") return segment;
      const value = decoded[i];
      const name = nameOf.get(value);
      if (name) return `:${name}`;
      return ID_LIKE.test(value) ? ":id" : segment;
    })
    .join("/");
  return scrubErrorText(pattern, 200);
}

/** A page load, a Remix data request (?_data=) or a form post. */
export function whereOf(request: Request): ErrorWhere {
  if (request.method !== "GET" && request.method !== "HEAD") return "action";
  return new URL(request.url).searchParams.has("_data") ? "data" : "page";
}

// "at loader (file:///C:/build/server/index.js:12:5)" -> "at loader (index.js:12:5)"
const FRAME_PATH = /(?:[a-z][a-z0-9+.-]*:\/\/\/?)?[^\s()]*[/\\]([^/\\\s()]+:\d+:\d+)/gi;

function topFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_FRAMES)
    .map((line) => scrubErrorText(line.replace(FRAME_PATH, "$1"), 160));
}

export function describeServerError(
  error: unknown,
  request: Request,
  params: Record<string, string | undefined> = {},
  where: ErrorWhere = whereOf(request),
): WebErrorReport {
  const isError = error instanceof Error;
  const text = isError ? error.message : typeof error === "string" ? error : `a thrown ${typeof error}`;
  return {
    where,
    method: request.method,
    route: routePattern(new URL(request.url).pathname, params),
    name: isError ? error.name || "Error" : "NonError",
    message: scrubErrorText(text),
    frames: isError ? topFrames(error.stack) : [],
  };
}

/** A deliberate response (redirect, 404, 403) or Remix's own 4xx, not a bug. */
function isExpected(error: unknown): boolean {
  if (error instanceof Response) return true;
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  const isErrorResponse =
    typeof e.status === "number" && typeof e.statusText === "string" && typeof e.internal === "boolean" && "data" in e;
  return isErrorResponse && (e.status as number) < 500;
}

// Remix can hand one error to two hooks (handleError and the render's
// onError); it is reported once.
const seen = new WeakSet<object>();

/** Logs the error and sends one report to the API. Never throws. */
export function reportServerError(error: unknown, options: ReportOptions): void {
  try {
    if (options.request.signal?.aborted || isExpected(error)) return;
    if (typeof error === "object" && error !== null) {
      if (seen.has(error)) return;
      seen.add(error);
    }
    console.error(error);
    const binding = options.env?.WEB_ERRORS;
    if (!binding) return;
    const report = describeServerError(error, options.request, options.params, options.where);
    const sent = Promise.resolve(binding.report(report)).catch(() => undefined);
    options.waitUntil?.(sent);
  } catch {
    // Reporting must never turn one error into a second one.
  }
}

/** What functions/_middleware.ts puts in Remix's load context. */
export interface ReportingContext {
  env?: { WEB_ERRORS?: WebErrorsBinding };
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Remix calls this for every unexpected error in a loader, an action or the render. */
export const handleError: HandleErrorFunction = (error, { request, params, context }) => {
  const ctx = (context ?? {}) as ReportingContext;
  reportServerError(error, { request, params, env: ctx.env, waitUntil: ctx.waitUntil });
};
