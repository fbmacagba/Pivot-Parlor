/**
 * Website server errors. Pages Functions have no Workers Issues of their own,
 * so the website (apps/web/app/lib/serverErrors.ts) hands each server error to
 * this named entrypoint over its WEB_ERRORS service binding. Logging it here
 * with console.error opens an issue on pivot-parlor-api and emails the owner
 * (docs/runbooks/production-alerting.md).
 *
 * A named entrypoint is reachable only through a service binding, never from
 * the internet, so nothing outside our own website can post a fake error.
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

function clean(input: Record<string, unknown>): CleanReport {
  const where = typeof input.where === "string" && WHERE.has(input.where) ? input.where : "unknown";
  const method = typeof input.method === "string" && /^[A-Z]{3,7}$/.test(input.method) ? input.method : "UNKNOWN";
  const route =
    typeof input.route === "string" && /^\/\S*$/.test(input.route) ? scrubErrorText(input.route, MAX_ROUTE) : "unknown";
  const name = typeof input.name === "string" && /^[A-Za-z_$][\w$.]{0,59}$/.test(input.name) ? input.name : "Error";
  const message = typeof input.message === "string" ? scrubErrorText(input.message, MAX_MESSAGE) : "";
  const frames = Array.isArray(input.frames)
    ? input.frames
        .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .slice(0, MAX_FRAMES)
        .map((f) => f.trim().slice(0, MAX_FRAME))
    : [];
  return { where, method, route, name, message: message || "none", frames: frames.length ? frames.join(" | ") : "none" };
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

    console.error(`[web] ${r.name} in ${r.where} ${r.method} ${r.route}`, { message: r.message, frames: r.frames });
    return { logged: true };
  }
}
