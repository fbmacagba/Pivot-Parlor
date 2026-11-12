/**
 * JavaScript errors in visitors' browsers reach the owner's alert email.
 *
 * The browser (app/lib/browserErrorReporter.ts) posts each error to our own
 * website at CLIENT_ERRORS_PATH; the website (app/lib/clientErrorsEndpoint.ts,
 * run by functions/_middleware.ts) checks it and hands it to the API worker's
 * WebErrors entrypoint over the WEB_ERRORS binding, whose log line Workers
 * Issues turns into an email (docs/runbooks/production-alerting.md).
 *
 * Only errors that ran through our own scripts are reported: at least one of
 * the top frames must be /assets/ on our origin, and none may be an extension.
 * That leaves out extensions, Stripe, Turnstile, "Script error." (no stack)
 * and server errors (Remix hands them to the browser with no stack). A lost
 * connection, a stale script after a deploy and an aborted request are not
 * bugs and are left out too.
 *
 * What is sent: the kind, the Remix route id, the error type, the message with
 * emails, ids, tokens and long numbers masked, and the top frames with our own
 * script paths kept and every other location replaced by "<other>". Never the
 * page URL, its query, page content, cookies, the user or browser details.
 *
 * This file is pure: both the browser and the website use it.
 */
import { scrubErrorText } from "@repo/utils";

export const CLIENT_ERRORS_PATH = "/client-errors";

export const BROWSER_ERROR_KINDS = ["script", "promise", "hydration", "render"] as const;
export type BrowserErrorKind = (typeof BROWSER_ERROR_KINDS)[number];

/** Frames sent per error; the API keeps the same number. */
export const MAX_FRAMES = 5;
/** Errors one page load reports at most. */
export const MAX_REPORTS_PER_PAGE = 5;
const MAX_FRAME = 200;
const MAX_MESSAGE = 300;

/** What the browser posts to CLIENT_ERRORS_PATH. */
export interface BrowserErrorPayload {
  kind: BrowserErrorKind;
  /** The Remix route id of the page ("routes/contact"), or "unknown". */
  route: string;
  name: string;
  message: string;
  /** "/assets/<file>:<line>:<col>" for our own code, "<other>" for anything else. */
  frames: string[];
}

/**
 * An extension's location in any browser's spelling, or the bare scheme
 * Chrome sometimes reports (the CSP reporter met it on 2026-11-12).
 */
export const EXTENSION_FRAME = /(?:^|[\s(@])(?:[a-z-]+-extension|webkit-masked-url)(?::|[\s)]|$)/i;

/** A frame in our own scripts, once its origin is removed. */
export const OWN_FRAME = /(?:^|[\s(@])\/assets\/[^\s()]+:\d+:\d+/;

// A frame line ends in its location: "at f (url:1:2)", "f@url:1:2".
const LOCATED = /:\d+:\d+\)?$/;
const URL_IN_FRAME = /\b[a-z][a-z0-9+.-]*:\/\/[^\s()]*/gi;
const LINE_COL = /(:\d+:\d+)$/;

function ownPath(location: string, origin: string): string | null {
  const [, lineCol = ""] = location.match(LINE_COL) ?? [];
  const base = lineCol ? location.slice(0, -lineCol.length) : location;
  try {
    const url = new URL(base);
    return url.origin === origin && url.pathname.startsWith("/assets/") ? `${url.pathname}${lineCol}` : null;
  } catch {
    return null;
  }
}

/**
 * The top frames of a browser stack, our own script paths kept and every other
 * location replaced. null when the error is not ours to report: an extension
 * is in the stack, or none of the top frames is our own code.
 */
export function browserFrames(stack: string, origin: string): string[] | null {
  const lines = stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => EXTENSION_FRAME.test(line))) return null;
  const frames = lines
    .filter((line) => LOCATED.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.replace(URL_IN_FRAME, (location) => ownPath(location, origin) ?? "<other>").slice(0, MAX_FRAME));
  return frames.some((frame) => OWN_FRAME.test(frame)) ? frames : null;
}

// A lost connection or a script removed by a deploy, in each browser's words.
const NOT_A_BUG = [
  /^Failed to fetch\b/,
  /^NetworkError when attempting to fetch resource/,
  /^Load failed$/,
  /^Network request failed$/,
  /Failed to fetch dynamically imported module/,
  /Importing a module script failed/,
  /error loading dynamically imported module/i,
];

/** The report for one error, or null when it is not ours to report. */
export function describeBrowserError(
  error: unknown,
  kind: BrowserErrorKind,
  origin: string,
  route: string | undefined,
): BrowserErrorPayload | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { name?: unknown; message?: unknown; stack?: unknown };
  if (typeof e.stack !== "string") return null;
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const message = typeof e.message === "string" ? e.message : "";
  if (name === "AbortError" || NOT_A_BUG.some((pattern) => pattern.test(message))) return null;
  const frames = browserFrames(e.stack, origin);
  if (!frames) return null;
  const isDom = typeof DOMException !== "undefined" && error instanceof DOMException;
  return {
    kind,
    route: route || "unknown",
    name: isDom ? "DOMException" : name,
    message: scrubErrorText(isDom ? `${name}: ${message}` : message, MAX_MESSAGE),
    frames,
  };
}
