/**
 * The website half of the browser-error alert (what is reported and why:
 * app/lib/browserErrors.ts). functions/_middleware.ts runs this for a POST to
 * CLIENT_ERRORS_PATH, before Remix.
 *
 * Anyone can post here, so a report goes on to the API's WebErrors entrypoint
 * only when it came from one of our own pages (Origin), from a browser that
 * is not a bot, is small, names one of the site's real page routes, and has
 * at least one frame in our own scripts and none in an extension. The API
 * then builds the alert title only from known values and rate-limits by
 * visitor and by title (apps/worker/src/web-errors.ts).
 *
 * The visitor's IP goes along for the per-visitor limit only; it is never
 * logged. The answer is always 204, so a sender learns nothing from it.
 */
import { isbot } from "isbot";
import { scrubErrorText } from "@repo/utils";
import { CLIENT_IP_HEADER } from "./apiTransport";
import {
  BROWSER_ERROR_KINDS,
  EXTENSION_FRAME,
  MAX_FRAMES,
  OWN_FRAME,
  type BrowserErrorKind,
  type BrowserErrorPayload,
} from "./browserErrors";

/** A real report is well under 2 KB. */
export const MAX_BODY_BYTES = 8 * 1024;

/** What the API's WebErrors.reportBrowser accepts. */
export interface BrowserErrorReport extends BrowserErrorPayload {
  /** For the per-visitor limit only. */
  ip?: string;
}

export interface BrowserErrorsBinding {
  reportBrowser(report: BrowserErrorReport): Promise<unknown> | unknown;
}

export interface ClientErrorsOptions {
  /** Route ids that render a page (pageRouteIds): the only routes a browser error can come from. */
  pageRoutes: ReadonlySet<string>;
  binding?: BrowserErrorsBinding;
  /** Keeps the report alive after the response is sent. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Route ids with a component. A resource route (no default export) renders nothing in a browser. */
export function pageRouteIds(routes: Record<string, { module?: { default?: unknown } } | undefined>): Set<string> {
  return new Set(
    Object.entries(routes)
      .filter(([, route]) => route?.module?.default != null)
      .map(([id]) => id),
  );
}

const KINDS: ReadonlySet<string> = new Set(BROWSER_ERROR_KINDS);
const NAME = /^[A-Za-z_$][\w$]{0,59}$/;

async function readCapped(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get("Content-Length")) > max || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readReport(request: Request, pageRoutes: ReadonlySet<string>): Promise<BrowserErrorReport | null> {
  if (request.method !== "POST") return null;
  // A browser always sends Origin on a POST; ours is the page's own.
  if (request.headers.get("Origin") !== new URL(request.url).origin) return null;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return null;
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return null;
  if (isbot(request.headers.get("User-Agent") ?? "")) return null;

  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;

  if (typeof b.kind !== "string" || !KINDS.has(b.kind)) return null;
  if (typeof b.route !== "string" || (b.route !== "unknown" && !pageRoutes.has(b.route))) return null;
  if (!Array.isArray(b.frames)) return null;
  const frames = b.frames.filter((f): f is string => typeof f === "string").slice(0, MAX_FRAMES);
  if (frames.some((f) => EXTENSION_FRAME.test(f)) || !frames.some((f) => OWN_FRAME.test(f))) return null;

  const ip = request.headers.get(CLIENT_IP_HEADER);
  return {
    kind: b.kind as BrowserErrorKind,
    route: b.route,
    name: typeof b.name === "string" && NAME.test(b.name) ? b.name : "Error",
    message: typeof b.message === "string" ? scrubErrorText(b.message, 300) : "",
    frames: frames.map((f) => scrubErrorText(f, 160)),
    ...(ip ? { ip } : {}),
  };
}

/** Checks one browser report and passes it on. Always 204; never throws. */
export async function handleClientErrors(request: Request, options: ClientErrorsOptions): Promise<Response> {
  try {
    const report = await readReport(request, options.pageRoutes);
    const binding = options.binding;
    if (report && binding) {
      const sent = Promise.resolve()
        .then(() => binding.reportBrowser(report))
        .catch(() => undefined);
      options.waitUntil?.(sent);
    }
  } catch {
    // A bad report is dropped; it never becomes an error of ours.
  }
  return new Response(null, { status: 204 });
}
