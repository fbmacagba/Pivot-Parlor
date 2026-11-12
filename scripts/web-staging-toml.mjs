/**
 * apps/web/wrangler.toml as a staging Pages deploy needs it. The rewrite
 * behind scripts/ci-set-web-staging-vars.mjs, kept pure so
 * apps/workers/uptime/test/alerting-config.test.ts can run it on the real file.
 *
 * Three changes vs prod:
 *   API_URL    → the staging worker (so the BFF proxies to staging, not prod)
 *   APP_DOMAIN → "localhost" (forces a host-only session cookie that works on
 *                *.pages.dev; the prod value sets Domain=.pivotparlor.com; Secure,
 *                which a *.pages.dev host rejects → login loop)
 *   EVERY [[services]] entry on pivot-parlor-api → pivot-parlor-api-staging
 */

export const STAGING_API_URL = "https://pivot-parlor-api-staging.bmorris0565.workers.dev";
export const STAGING_APP_DOMAIN = "localhost";
export const STAGING_API_WORKER = "pivot-parlor-api-staging";

function setVar(src, key, value) {
  const re = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*).*$`, "m");
  if (!re.test(src)) {
    throw new Error(`Could not find "${key}" in apps/web/wrangler.toml (wrangler.toml format changed?)`);
  }
  return src.replace(re, `$1"${value}"`);
}

// Every binding to the API follows API_URL:
//   API        the website reroutes calls to API_URL's origin over it, so a
//              prod binding with a staging URL would send staging traffic to
//              the production API.
//   WEB_ERRORS server-error reports (app/lib/serverErrors.ts). On the prod API
//              they would email the owner about staging test runs; the staging
//              API's Issues are off.
// [ \t] rather than \s: \s would run past the line end and eat the next one.
function setApiServices(src, worker) {
  const re = /^([ \t]*service[ \t]*=[ \t]*)"pivot-parlor-api(?:-staging)?"[ \t]*$/gm;
  if (!re.test(src)) {
    throw new Error("Could not find the API [[services]] entries in apps/web/wrangler.toml (wrangler.toml format changed?)");
  }
  re.lastIndex = 0;
  return src.replace(re, `$1"${worker}"`);
}

/** The staging version of apps/web/wrangler.toml. Idempotent. */
export function toStagingWebToml(toml) {
  let out = setVar(toml, "API_URL", STAGING_API_URL);
  out = setVar(out, "APP_DOMAIN", STAGING_APP_DOMAIN);
  out = setApiServices(out, STAGING_API_WORKER);
  // Any production worker name left (a comment after it, a new spelling)
  // fails the deploy instead of quietly binding staging to production.
  if (/^[^#\n]*"pivot-parlor-api"/m.test(out)) {
    throw new Error("apps/web/wrangler.toml still names pivot-parlor-api after the staging rewrite");
  }
  return out;
}
