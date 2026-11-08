#!/usr/bin/env node
/**
 * Rewrite apps/web/wrangler.toml [vars] to point a Pages deploy at the STAGING
 * worker, for an E2E preview deploy (`wrangler pages deploy --branch=staging`).
 *
 * Three changes vs prod:
 *   API_URL    → the staging worker (so the BFF proxies to staging, not prod)
 *   APP_DOMAIN → "localhost" (forces a host-only session cookie that works on
 *                *.pages.dev; the prod value sets Domain=.pivotparlor.com; Secure,
 *                which a *.pages.dev host rejects → login loop)
 *   [[services]] API → pivot-parlor-api-staging (the binding API calls use)
 *
 * EPHEMERAL: this rewrite is for a throwaway CI checkout (or a local run you
 * revert with `git checkout apps/web/wrangler.toml`). NEVER commit the result —
 * --branch=staging writes preview-scope Pages vars, but a committed prod
 * wrangler.toml pointing at staging would break the next production deploy.
 *
 * Idempotent: re-running it leaves the staging values in place.
 *
 *   node scripts/ci-set-web-staging-vars.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tomlPath = join(__dirname, "..", "apps", "web", "wrangler.toml");

const STAGING_API_URL = "https://pivot-parlor-api-staging.bmorris0565.workers.dev";
const STAGING_APP_DOMAIN = "localhost";
const STAGING_API_WORKER = "pivot-parlor-api-staging";

let toml = readFileSync(tomlPath, "utf8");

function setVar(src, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, "m");
  if (!re.test(src)) {
    throw new Error(`Could not find "${key}" in ${tomlPath} — wrangler.toml format changed?`);
  }
  return src.replace(re, `$1"${value}"`);
}

// The API service binding must follow API_URL: the website reroutes calls to
// API_URL's origin over this binding, so a prod binding with a staging URL
// would send staging traffic to the production API.
function setApiService(src, worker) {
  const re = /^(\s*service\s*=\s*)"pivot-parlor-api(?:-staging)?"\s*$/m;
  if (!re.test(src)) {
    throw new Error(`Could not find the API [[services]] entry in ${tomlPath} — wrangler.toml format changed?`);
  }
  return src.replace(re, `$1"${worker}"`);
}

toml = setVar(toml, "API_URL", STAGING_API_URL);
toml = setVar(toml, "APP_DOMAIN", STAGING_APP_DOMAIN);
toml = setApiService(toml, STAGING_API_WORKER);

writeFileSync(tomlPath, toml);

console.log("✓ ci-set-web-staging-vars: apps/web/wrangler.toml now points at staging");
console.log(`    API_URL    = "${STAGING_API_URL}"`);
console.log(`    APP_DOMAIN = "${STAGING_APP_DOMAIN}"`);
console.log(`    API binding service = "${STAGING_API_WORKER}"`);
console.log("  (ephemeral — revert with `git checkout apps/web/wrangler.toml`; never commit)");
