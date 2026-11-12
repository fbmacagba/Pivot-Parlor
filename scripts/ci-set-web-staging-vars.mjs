#!/usr/bin/env node
/**
 * Rewrite apps/web/wrangler.toml to point a Pages deploy at the STAGING
 * worker, for an E2E preview deploy (`wrangler pages deploy --branch=staging`).
 *
 * What changes, and why, is in scripts/web-staging-toml.mjs: API_URL,
 * APP_DOMAIN, and every [[services]] binding to the API (API and WEB_ERRORS).
 * apps/workers/uptime/test/alerting-config.test.ts runs that rewrite on the
 * real file and fails if any binding stays on production.
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
import { STAGING_API_URL, STAGING_APP_DOMAIN, STAGING_API_WORKER, toStagingWebToml } from "./web-staging-toml.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tomlPath = join(__dirname, "..", "apps", "web", "wrangler.toml");

writeFileSync(tomlPath, toStagingWebToml(readFileSync(tomlPath, "utf8")));

console.log("✓ ci-set-web-staging-vars: apps/web/wrangler.toml now points at staging");
console.log(`    API_URL    = "${STAGING_API_URL}"`);
console.log(`    APP_DOMAIN = "${STAGING_APP_DOMAIN}"`);
console.log(`    API and WEB_ERRORS binding service = "${STAGING_API_WORKER}"`);
console.log("  (ephemeral — revert with `git checkout apps/web/wrangler.toml`; never commit)");
