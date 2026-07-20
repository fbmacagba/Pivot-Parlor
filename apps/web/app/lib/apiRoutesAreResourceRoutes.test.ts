import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The `api.*` routes are BFF endpoints: the browser and the dev-dashboard
// pollers call them with a raw `fetch()` expecting the action/loader JSON.
//
// In Remix (classic data mode, v3_singleFetch: false) a route that exports a
// default *component* is a UI route. A raw `fetch()` carries no `?_data`
// data-request signal, so Remix treats it as a *document* request: it runs the
// action/loader and then returns the full HTML shell (Content-Type text/html)
// with the result buried in `window.__remixContext`. The caller's
// `res.json()` then throws and the real payload is silently lost.
//
// Regression this guards: the dev-shops regenerate flow raw-fetched
// `/api/shops/:id/generate-site`, `/settings`, and `/jobs/:id/status`. Those
// routes each shipped a stray `export default function X() { return null; }`,
// so every call got HTML back — the site generation job actually started
// (worker returned 202) but the UI showed "Could not start generation." and
// the progress poller never ran. Resource routes (no default export) return
// JSON to a raw fetch, which is what every `api.*` route must be.
//
// vitest runs with cwd at the app root (apps/web); the "discovers files"
// assertion below fails loudly if that ever stops holding.
const routesDir = path.resolve(process.cwd(), "app/routes");

const apiRouteFiles = readdirSync(routesDir).filter(
  (f) => f.startsWith("api.") && f.endsWith(".tsx") && !f.endsWith(".test.tsx"),
);

describe("api.* routes are resource routes (no default export)", () => {
  it("discovers the api route files to check", () => {
    expect(apiRouteFiles.length).toBeGreaterThan(0);
  });

  it.each(apiRouteFiles)("%s exports no default component", (file) => {
    const src = readFileSync(path.join(routesDir, file), "utf8");
    expect(src).not.toMatch(/^\s*export\s+default\b/m);
  });
});
