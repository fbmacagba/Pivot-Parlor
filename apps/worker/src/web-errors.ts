/**
 * Website errors. Pages Functions have no Workers Issues of their own, so the
 * website hands each server error (apps/web/app/lib/serverErrors.ts) and each
 * visitor's browser error (apps/web/app/lib/clientErrorsEndpoint.ts) to this
 * named entrypoint over its WEB_ERRORS service binding. Logging it here with
 * console.error opens an issue on pivot-parlor-api and emails the owner
 * (docs/runbooks/production-alerting.md).
 *
 * A named entrypoint is reachable only through a service binding, never from
 * the internet: a server error can only come from our website's own code. A
 * browser error comes from anyone's browser through the website's public
 * /client-errors, so reportBrowser trusts nothing it is sent (below).
 * The website's staging deploy binds to pivot-parlor-api-staging, whose
 * Issues is off.
 *
 * Every field is re-checked here: the kind, route and method go into the
 * message (one issue per distinct error and route), the rest into a details
 * object of strings, which Issues masks.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { scrubErrorText } from "@repo/utils";
import type { Bindings } from "./bindings.js";

const WHERE = new Set(["page", "data", "action", "render", "middleware"]);
const MAX_FRAMES = 5;
const MAX_FRAME = 160;
const MAX_ROUTE = 200;
const MAX_MESSAGE = 300;

/** What the website sends: see describeServerError in the web app. */
export interface WebErrorReport {
  where: string;
  method: string;
  route: string;
  name: string;
  message: string;
  frames: string[];
}

interface CleanReport {
  where: string;
  method: string;
  route: string;
  name: string;
  message: string;
  frames: string;
}

const cleanMessage = (v: unknown): string => (typeof v === "string" && scrubErrorText(v, MAX_MESSAGE)) || "none";

function cleanFrames(v: unknown): string {
  const frames = Array.isArray(v)
    ? v
        .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .slice(0, MAX_FRAMES)
        .map((f) => f.trim().slice(0, MAX_FRAME))
    : [];
  return frames.length ? frames.join(" | ") : "none";
}

function clean(input: Record<string, unknown>): CleanReport {
  const where = typeof input.where === "string" && WHERE.has(input.where) ? input.where : "unknown";
  const method = typeof input.method === "string" && /^[A-Z]{3,7}$/.test(input.method) ? input.method : "UNKNOWN";
  const route =
    typeof input.route === "string" && /^\/\S*$/.test(input.route) ? scrubErrorText(input.route, MAX_ROUTE) : "unknown";
  const name = typeof input.name === "string" && /^[A-Za-z_$][\w$.]{0,59}$/.test(input.name) ? input.name : "Error";
  return { where, method, route, name, message: cleanMessage(input.message), frames: cleanFrames(input.frames) };
}

// Browser errors come from anyone's browser through the website, and each new
// title is a new issue and email. So every part of the title is from a fixed
// list or a route id's shape here, and the website accepts only the site's
// real page routes: together, a forged report can only pick among a bounded
// set of titles (kinds x names x pages), each one rate-limited below.
const BROWSER_KINDS = new Set(["hydration", "render", "script", "promise"]);
const BROWSER_NAMES = new Set([
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
  "BrowserAlertTestError",
]);
const ROUTE_ID = /^(?:root|routes\/[A-Za-z0-9_.$[\]-]{1,150})$/;
const IP = /^[0-9a-fA-F.:]{3,45}$/;

/** What the website sends: see apps/web/app/lib/browserErrors.ts. */
export interface BrowserErrorReport {
  kind: string;
  route: string;
  name: string;
  message: string;
  frames: string[];
  /** The visitor's IP, for the per-visitor limit only. Never logged. */
  ip?: string;
}

export class WebErrors extends WorkerEntrypoint<Bindings> {
  /** Not an HTTP endpoint: a named entrypoint has no public route anyway. */
  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  async report(input: unknown): Promise<{ logged: boolean }> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { logged: false };
    const r = clean(input as Record<string, unknown>);

    // One broken route can fail on every request: cap how often it is logged.
    const limiter = this.env.WEB_ERROR_LIMITER;
    if (limiter) {
      const { success } = await limiter.limit({ key: `web:${r.where}:${r.method}:${r.route}` });
      if (!success) return { logged: false };
    }

    // The details must not have a `message` key: Workers Logs would take the
    // object's `message` as the event and drop this title (seen on staging
    // 2026-11-12), and Issues would title the email with the bare error text.
    console.error(`[web] ${r.name} in ${r.where} ${r.method} ${r.route}`, { detail: r.message, frames: r.frames });
    return { logged: true };
  }

  /** A JavaScript error in a visitor's browser, forwarded by the website. */
  async reportBrowser(input: unknown): Promise<{ logged: boolean }> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { logged: false };
    const r = input as Record<string, unknown>;
    const kind = typeof r.kind === "string" && BROWSER_KINDS.has(r.kind) ? r.kind : "unknown";
    const route = typeof r.route === "string" && ROUTE_ID.test(r.route) ? r.route : "unknown";
    const name = typeof r.name === "string" && BROWSER_NAMES.has(r.name) ? r.name : "Error";

    // Per visitor, then per title: one browser or one broken page cannot
    // log without end.
    const limiter = this.env.WEB_ERROR_LIMITER;
    if (limiter) {
      if (typeof r.ip === "string" && IP.test(r.ip)) {
        const { success } = await limiter.limit({ key: `browser-ip:${r.ip}` });
        if (!success) return { logged: false };
      }
      const { success } = await limiter.limit({ key: `browser:${kind}:${route}:${name}` });
      if (!success) return { logged: false };
    }

    // No `message` key in the details: see report() above.
    console.error(`[browser] ${name} in ${kind} on ${route}`, { detail: cleanMessage(r.message), frames: cleanFrames(r.frames) });
    return { logged: true };
  }
}
