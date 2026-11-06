#!/usr/bin/env node
/**
 * Live Site Verification (real HTTP only, no mocks). 9 checks.
 * Env overrides: LIVE_VERIFY_WORKER_URL, LIVE_VERIFY_PAGES_URL
 */

/** Public API host (avoid *.workers.dev if Cloudflare Access wraps it — returns HTML, not JSON). */
const WORKER = process.env.LIVE_VERIFY_WORKER_URL ?? "https://api.pivotparlor.com";
const PAGES = process.env.LIVE_VERIFY_PAGES_URL ?? "https://pivotparlor.com";

const JSON_SLUG = "gate8-verify-nonexistent-shop-xyz";

const results = /** @type {Array<{ name: string; pass: boolean; detail?: string }>} */ ([]);

function logCheck(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[LIVE CHECK] ${name}: ${pass ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
}

async function safeFetch(url, init) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return { res, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`connection failed: ${msg}`);
  }
}

function isHtmlContentType(ct) {
  return (ct ?? "").toLowerCase().includes("text/html");
}

function isJsonContentType(ct) {
  return (ct ?? "").toLowerCase().includes("application/json");
}

// Check 1 — Worker health
async function check1() {
  try {
    let { res } = await safeFetch(`${WORKER}/health`);
    if (res.status === 200 || res.status === 404) {
      logCheck("Worker health", true);
      return true;
    }
    if (res.status >= 500) {
      logCheck("Worker health", false, `HTTP ${res.status} on /health`);
      return false;
    }
    const root = await safeFetch(`${WORKER}/`);
    if (root.res.status === 200 || root.res.status === 404) {
      logCheck("Worker health", true);
      return true;
    }
    logCheck("Worker health", false, `HTTP ${root.res.status} on /`);
    return false;
  } catch (e) {
    logCheck("Worker health", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 2 — Dev login endpoint (do not use dev@pivotparlor.com + arbitrary password: Worker bootstraps
// that email on first login with the submitted password, which can return 200.)
async function check2() {
  try {
    const { res, text } = await safeFetch(`${WORKER}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "gate8-live-verify-nonexistent@pivotparlor.com",
        password: "definitely-wrong-password",
      }),
    });
    if (res.status === 400 || res.status === 401) {
      logCheck("Dev login endpoint", true);
      return true;
    }
    if (res.status === 404) {
      logCheck("Dev login endpoint", false, "HTTP 404 — route not registered");
      return false;
    }
    if (res.status >= 500) {
      logCheck("Dev login endpoint", false, `HTTP ${res.status} body=${text.slice(0, 200)}`);
      return false;
    }
    logCheck("Dev login endpoint", false, `unexpected HTTP ${res.status} body=${text.slice(0, 200)}`);
    return false;
  } catch (e) {
    logCheck("Dev login endpoint", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 3 — Shop services endpoint
async function check3() {
  try {
    const { res, text } = await safeFetch(`${WORKER}/api/shops/test-slug/services`);
    if (res.status >= 500) {
      logCheck("Services endpoint", false, `HTTP ${res.status} ${text.slice(0, 300)}`);
      return false;
    }
    if (isHtmlContentType(res.headers.get("content-type"))) {
      logCheck("Services endpoint", false, "HTML response instead of JSON");
      return false;
    }
    if (res.status === 200) {
      try {
        const j = JSON.parse(text);
        if (j.success === true && Array.isArray(j.data)) {
          logCheck("Services endpoint", true);
          return true;
        }
      } catch {
        /* fall through */
      }
      logCheck("Services endpoint", false, `HTTP 200 but invalid JSON shape: ${text.slice(0, 200)}`);
      return false;
    }
    if (res.status === 404) {
      try {
        const j = JSON.parse(text);
        if (j.success === false) {
          logCheck("Services endpoint", true);
          return true;
        }
      } catch {
        /* fall through */
      }
      logCheck("Services endpoint", false, `HTTP 404 but body not JSON success:false: ${text.slice(0, 200)}`);
      return false;
    }
    logCheck("Services endpoint", false, `HTTP ${res.status} ${text.slice(0, 200)}`);
    return false;
  } catch (e) {
    logCheck("Services endpoint", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 4 — API returns JSON
async function check4() {
  try {
    const { res } = await safeFetch(`${WORKER}/api/shops/${JSON_SLUG}/services`);
    const ct = res.headers.get("content-type") ?? "";
    if (isHtmlContentType(ct)) {
      logCheck("API returns JSON", false, `Content-Type was HTML: ${ct}`);
      return false;
    }
    if (!isJsonContentType(ct)) {
      logCheck("API returns JSON", false, `Content-Type missing application/json: ${ct}`);
      return false;
    }
    logCheck("API returns JSON", true);
    return true;
  } catch (e) {
    logCheck("API returns JSON", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 5 — Homepage
async function check5() {
  try {
    const { res, text } = await safeFetch(`${PAGES}/`);
    if (res.status !== 200) {
      logCheck("Homepage loads", false, `HTTP ${res.status}`);
      return false;
    }
    if (!/Pivot Parlor/i.test(text)) {
      logCheck("Homepage loads", false, "body missing 'Pivot Parlor'");
      return false;
    }
    logCheck("Homepage loads", true);
    return true;
  } catch (e) {
    logCheck("Homepage loads", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 6 — Dev login page
async function check6() {
  try {
    const { res, text } = await safeFetch(`${PAGES}/login`);
    if (res.status !== 200) {
      logCheck("Dev login page", false, `HTTP ${res.status}`);
      return false;
    }
    if (!/login|sign in/i.test(text)) {
      logCheck("Dev login page", false, "body missing login/sign in");
      return false;
    }
    logCheck("Dev login page", true);
    return true;
  } catch (e) {
    logCheck("Dev login page", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 7 — Booking page
async function check7() {
  try {
    const { res, text } = await safeFetch(`${PAGES}/test-shop/book`);
    if (res.status >= 500) {
      logCheck("Booking page", false, `HTTP ${res.status} ${text.slice(0, 150)}`);
      return false;
    }
    if (res.status === 200 || res.status === 404) {
      logCheck("Booking page", true);
      return true;
    }
    logCheck("Booking page", false, `HTTP ${res.status}`);
    return false;
  } catch (e) {
    logCheck("Booking page", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 8 — No raw Cloudflare errors on /api/*
async function check8() {
  try {
    const { text } = await safeFetch(`${PAGES}/api/anything`);
    if (/Error 1101|Worker threw exception/i.test(text)) {
      logCheck("No raw errors", false, "Cloudflare raw error page in body");
      return false;
    }
    logCheck("No raw errors", true);
    return true;
  } catch (e) {
    logCheck("No raw errors", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Check 9 — Stripe webhook must not redirect (Stripe requires 2xx JSON, not 301/302)
async function check9() {
  try {
    const res = await fetch(`${WORKER}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      redirect: "manual",
    });
    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
      logCheck("Webhook endpoint (no redirect)", false, `HTTP ${res.status} redirect to ${res.headers.get("location") ?? "?"}`);
      return false;
    }
    // Expected: 400 (bad/missing signature) or 500 (webhook secret unset) — never a redirect
    if (res.status === 400 || res.status === 500) {
      logCheck("Webhook endpoint (no redirect)", true);
      return true;
    }
    if (res.status === 200) {
      logCheck("Webhook endpoint (no redirect)", true);
      return true;
    }
    const text = await res.text();
    logCheck("Webhook endpoint (no redirect)", false, `unexpected HTTP ${res.status} ${text.slice(0, 200)}`);
    return false;
  } catch (e) {
    logCheck("Webhook endpoint (no redirect)", false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function main() {
  console.log(`[LIVE CHECK] Worker base: ${WORKER}`);
  console.log(`[LIVE CHECK] Pages base: ${PAGES}`);
  console.log("");

  await check1();
  await check2();
  await check3();
  await check4();
  await check5();
  await check6();
  await check7();
  await check8();
  await check9();

  const passed = results.filter((r) => r.pass).length;
  console.log("");
  console.log(`[LIVE CHECK] Overall: ${passed}/9 passed`);

  if (passed < 9) {
    console.log("");
    console.log("[LIVE CHECK] Failed checks detail:");
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  - ${r.name}: ${r.detail ?? "FAIL"}`);
    }
    process.exit(1);
  }
}

main();
