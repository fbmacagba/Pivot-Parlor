/**
 * The browser half of the browser-error alert (what is reported and why:
 * app/lib/browserErrors.ts). entry.client.tsx installs it before hydrating;
 * it listens for uncaught errors and unhandled rejections, and the app hands
 * in hydration errors (entry.client.tsx) and render errors (ErrorScreen).
 *
 * Each page load reports a few distinct errors at most. Sending never throws.
 * It asks for no cookies; WebKit sent the session cookie anyway when measured
 * (2026-11-12), and the website never reads it (clientErrorsEndpoint.ts).
 */
import {
  CLIENT_ERRORS_PATH,
  describeBrowserError,
  MAX_REPORTS_PER_PAGE,
  type BrowserErrorKind,
  type BrowserErrorPayload,
} from "./browserErrors";

type Listener = (event: Event) => void;

export interface BrowserErrorReporterOptions {
  /** Where errors are listened for. Defaults to window. */
  target?: { addEventListener(type: string, listener: Listener): void; removeEventListener(type: string, listener: Listener): void };
  /** Our own origin. Defaults to the page's. */
  origin?: string;
  /** The current page's Remix route id. Defaults to the deepest match of Remix's router. */
  routeId?: () => string | undefined;
  /** Sends one report. Defaults to a POST to our own website. */
  send?: (payload: BrowserErrorPayload) => void;
}

interface RemixRouterGlobal {
  __remixRouter?: { state?: { matches?: Array<{ route?: { id?: string } }> } };
}

function currentRouteId(): string | undefined {
  const matches = (window as unknown as RemixRouterGlobal).__remixRouter?.state?.matches;
  return matches?.[matches.length - 1]?.route?.id;
}

function post(payload: BrowserErrorPayload): void {
  fetch(CLIENT_ERRORS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // Survives the visitor leaving the page; our own site, no cookies asked for.
    keepalive: true,
    credentials: "omit",
  }).catch(() => undefined);
}

let active: ((error: unknown, kind: BrowserErrorKind) => void) | null = null;

/** Hands one error to the installed reporter. Does nothing before install. */
export function reportBrowserError(error: unknown, kind: BrowserErrorKind): void {
  active?.(error, kind);
}

/** Starts reporting this page's errors. Returns a function that stops it. */
export function installBrowserErrorReporter(options: BrowserErrorReporterOptions = {}): () => void {
  const target = options.target ?? window;
  const origin = options.origin ?? window.location.origin;
  const routeId = options.routeId ?? currentRouteId;
  const send = options.send ?? post;

  let sent = 0;
  const seen = new Set<string>();
  const report = (error: unknown, kind: BrowserErrorKind) => {
    try {
      if (sent >= MAX_REPORTS_PER_PAGE) return;
      const payload = describeBrowserError(error, kind, origin, routeId());
      if (!payload) return;
      // One error can reach more than one hook (a render error and the window).
      const key = `${payload.name}|${payload.message}|${payload.frames[0]}`;
      if (seen.has(key)) return;
      seen.add(key);
      sent++;
      send(payload);
    } catch {
      // Reporting must never turn one error into a second one.
    }
  };
  const onError: Listener = (event) => report((event as ErrorEvent).error, "script");
  const onRejection: Listener = (event) => report((event as PromiseRejectionEvent).reason, "promise");

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  active = report;
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    if (active === report) active = null;
  };
}
