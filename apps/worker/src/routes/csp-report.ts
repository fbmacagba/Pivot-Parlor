/**
 * CSP violation reports. When the website's Content-Security-Policy blocks
 * something, the browser POSTs a report here (`report-uri`, and `report-to`
 * through the Reporting-Endpoints header; apps/web/app/lib/securityHeaders.ts).
 * Each report about one of our pages is logged with console.error, so Workers
 * Issues opens an issue and the owner gets an email
 * (docs/runbooks/production-alerting.md).
 *
 * Its own app, dispatched before the main one (like the Stripe webhook): a
 * report comes from any origin with no credentials, so it needs a public,
 * credential-free CORS answer rather than the main app's credentialed one, and
 * it must never reach the audit gap guard, which would write an audit.gap row
 * for every report, junk included.
 *
 * Junk is kept out of the log: a per-IP rate limit (Cloudflare's rate-limiting
 * binding, no KV writes), a 16 KB body cap, reports caused by browser
 * extensions, and reports about pages that are not ours. Query strings are
 * stripped, since a URL's query can carry tokens or personal details.
 */
import { Hono } from "hono";
import type { Bindings } from "../bindings.js";

export const CSP_REPORT_PATH = "/csp-report";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REPORTS_PER_REQUEST = 20;

export type CspKind = "script" | "style" | "connection" | "frame" | "image" | "font" | "form" | "other";

/**
 * One literal message per kind: Workers Issues groups by the message with its
 * values masked, so each kind is its own issue and its own email subject.
 */
const KIND_MESSAGE: Record<CspKind, string> = {
  script: "[csp] blocked a script",
  style: "[csp] blocked a style",
  connection: "[csp] blocked a connection",
  frame: "[csp] blocked a frame",
  image: "[csp] blocked an image",
  font: "[csp] blocked a font",
  form: "[csp] blocked a form submission",
  other: "[csp] blocked something else",
};

/** Which kind of block a CSP directive is. */
export function cspKind(directive: string): CspKind {
  const d = directive.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (d.startsWith("script-src") || d === "worker-src") return "script";
  if (d.startsWith("style-src")) return "style";
  if (d === "connect-src") return "connection";
  if (d === "frame-src" || d === "child-src") return "frame";
  if (d === "img-src") return "image";
  if (d === "font-src") return "font";
  if (d === "form-action") return "form";
  return "other";
}

/** True for the requests this app answers: POST and the preflight OPTIONS. */
export function isCspReportRequest(request: Request, url: URL): boolean {
  if (request.method !== "POST" && request.method !== "OPTIONS") return false;
  return (url.pathname.replace(/\/$/, "") || "/") === CSP_REPORT_PATH;
}

/** A violation as a browser described it, before cleaning. */
interface RawViolation {
  directive?: string;
  blocked?: string;
  page?: string;
  source?: string;
  line?: string;
  disposition?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const lineOf = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? String(Math.trunc(v))
    : typeof v === "string" && /^\d{1,9}$/.test(v)
      ? v
      : undefined;

/** `report-uri` (application/csp-report): { "csp-report": { ... } }. */
function fromLegacy(r: Record<string, unknown>): RawViolation {
  return {
    directive: str(r["effective-directive"]) ?? str(r["violated-directive"]),
    blocked: str(r["blocked-uri"]),
    page: str(r["document-uri"]),
    source: str(r["source-file"]),
    line: lineOf(r["line-number"]),
    disposition: str(r["disposition"]),
  };
}

/** `report-to` (application/reports+json): one item of the batch. */
function fromReportingApi(item: Record<string, unknown>): RawViolation | null {
  if (item.type !== "csp-violation") return null;
  const b = item.body;
  if (!b || typeof b !== "object") return null;
  const body = b as Record<string, unknown>;
  return {
    directive: str(body.effectiveDirective),
    blocked: str(body.blockedURL),
    page: str(body.documentURL) ?? str(item.url),
    source: str(body.sourceFile),
    line: lineOf(body.lineNumber),
    disposition: str(body.disposition),
  };
}

function violationsIn(payload: unknown): RawViolation[] {
  const out: RawViolation[] = [];
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === "object") {
        const v = fromReportingApi(item as Record<string, unknown>);
        if (v) out.push(v);
      }
    }
  } else if (payload && typeof payload === "object") {
    const r = (payload as Record<string, unknown>)["csp-report"];
    if (r && typeof r === "object") out.push(fromLegacy(r as Record<string, unknown>));
  }
  return out.slice(0, MAX_REPORTS_PER_REQUEST);
}

// A full extension URL, or the bare scheme: Chrome's report-to names an
// extension's script as just "chrome-extension" (seen in production
// 2026-11-12, where the colon-only pattern let it through and alerted).
const EXTENSION = /^(?:[a-z-]+-extension|webkit-masked-url)(?::|$)/i;
const KEYWORD = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * A URL as it is logged: origin and path for http(s), the scheme alone for
 * anything else (data:, blob:), or a CSP keyword ("inline", "eval") as-is.
 * Never the query or fragment. Always a non-empty string.
 */
function cleanUri(raw: string | undefined): string {
  if (!raw) return "none";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    const k = raw.toLowerCase();
    return KEYWORD.test(k) ? k : "unknown";
  }
  if (u.protocol === "http:" || u.protocol === "https:") return (u.origin + u.pathname).slice(0, 300);
  return u.protocol.replace(/:$/, "") || "unknown";
}

/**
 * Whether a report is about one of our pages. Production accepts the live
 * site only; elsewhere staging and preview hosts and localhost count too, so a
 * misrouted staging page can never alert from production.
 */
function isOurPage(page: string | undefined, environment: string | undefined): boolean {
  if (!page) return false;
  let u: URL;
  try {
    u = new URL(page);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const production = environment === "production";
  if (u.protocol === "http:") return !production && (host === "localhost" || host === "127.0.0.1");
  if (u.protocol !== "https:") return false;
  if (host === "pivotparlor.com" || host.endsWith(".pivotparlor.com") || host === "pivot-parlor-web.pages.dev") return true;
  return !production && host.endsWith(".pivot-parlor-web.pages.dev");
}

/** The body as text, or null once it passes `max` bytes (never buffered past it). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Public and credential-free: a report carries no cookies. */
const CORS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// strict: false, so "/csp-report/" is the same route.
export const cspReportApp = new Hono<{ Bindings: Bindings }>({ strict: false });

cspReportApp.use("*", async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(CORS)) c.res.headers.set(name, value);
});

cspReportApp.options(CSP_REPORT_PATH, (c) => c.body(null, 204));

cspReportApp.post(CSP_REPORT_PATH, async (c) => {
  const limiter = c.env.CSP_REPORT_LIMITER;
  if (limiter) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: `csp:${ip}` });
    if (!success) return c.body(null, 429);
  }
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_BODY_BYTES) return c.body(null, 413);
  const text = await readCapped(c.req.raw, MAX_BODY_BYTES);
  if (text === null) return c.body(null, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return c.body(null, 400);
  }

  for (const v of violationsIn(payload)) {
    if ((v.blocked && EXTENSION.test(v.blocked)) || (v.source && EXTENSION.test(v.source))) continue;
    if (!isOurPage(v.page, c.env.ENVIRONMENT)) continue;
    const directive = (v.directive ?? "").toLowerCase().split(/\s+/)[0] ?? "";
    // Every value a non-empty string with the same keys each time, so a kind
    // always fingerprints as the same issue.
    console.error(KIND_MESSAGE[cspKind(directive)], {
      directive: /^[a-z-]{1,40}$/.test(directive) ? directive : "unknown",
      blocked: cleanUri(v.blocked),
      page: cleanUri(v.page),
      source: cleanUri(v.source),
      line: v.line ?? "none",
      disposition: v.disposition === "enforce" || v.disposition === "report" ? v.disposition : "none",
    });
  }
  return c.body(null, 204);
});
