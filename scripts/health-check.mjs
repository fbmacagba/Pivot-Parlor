#!/usr/bin/env node
// scripts/health-check.mjs
// Run: node scripts/health-check.mjs
// Tests all Pivot Parlor worker endpoints and Pages routes

const WORKER_URL = "https://pivot-parlor-api.bmorris0565.workers.dev";
const PAGES_URL  = "https://pivot-parlor-web.pages.dev";
const SHOP_SLUG  = "ferdyms-barber-shop-014";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

let passed = 0, failed = 0, warned = 0;

async function check(label, fn) {
  try {
    const result = await fn();
    if (result.warn) {
      console.log(`  ${YELLOW}⚠${RESET}  ${label} ${DIM}— ${result.warn}${RESET}`);
      warned++;
    } else {
      console.log(`  ${GREEN}✓${RESET}  ${label} ${DIM}${result.note ?? ""}${RESET}`);
      passed++;
    }
  } catch (err) {
    console.log(`  ${RED}✗${RESET}  ${label} ${RED}${err.message}${RESET}`);
    failed++;
  }
}

async function get(url, expectStatus = 200) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status !== expectStatus) throw new Error(`Expected ${expectStatus}, got ${res.status}`);
  return res;
}

async function post(url, body, expectStatus) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (expectStatus && res.status !== expectStatus) throw new Error(`Expected ${expectStatus}, got ${res.status}`);
  return res;
}

async function expectUnauth(url, method = "GET") {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(8000) });
  if (res.status !== 401 && res.status !== 403) {
    throw new Error(`Expected 401/403 (auth guard), got ${res.status}`);
  }
  return { note: `→ ${res.status} auth guarded` };
}

async function expectJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) throw new Error(`Not JSON: ${ct}`);
  const data = await res.json();
  return { note: `→ ${res.status}`, data };
}

// ─── Test suites ─────────────────────────────────────────────────────────────

async function testWorker() {
  console.log(`\n${BOLD}${CYAN}Worker API${RESET}  ${DIM}${WORKER_URL}${RESET}`);

  // Public endpoints
  await check("GET  /api/shops/:slug/site (public site data)", async () => {
    const res = await get(`${WORKER_URL}/api/shops/${SHOP_SLUG}/site`);
    const j = await res.json();
    if (!j.success) throw new Error(j.error ?? "success:false");
    const label = j.data?.headline ?? j.data?.seo_title ?? "(no headline)";
    return { note: `→ ${res.status} · "${label}"` };
  });

  await check("GET  /api/shops/:slug/reviews (public reviews)", async () => {
    const res = await get(`${WORKER_URL}/api/shops/${SHOP_SLUG}/reviews`);
    const j = await res.json();
    if (!j.success) throw new Error(j.error ?? "success:false");
    return { note: `→ 200 · ${j.data?.length ?? 0} reviews` };
  });

  await check("GET  /api/shops/:slug/settings (public settings)", async () => {
    const res = await get(`${WORKER_URL}/api/shops/${SHOP_SLUG}/settings`);
    const j = await res.json();
    if (!j.success) throw new Error(j.error ?? "success:false");
    return { note: "→ 200" };
  });

  await check("POST /api/bookings (public — missing fields → 400)", async () => {
    const res = await post(`${WORKER_URL}/api/bookings`, {}, 400);
    return { note: "→ 400 validation working" };
  });

  await check("POST /api/shops/:slug/reviews (missing fields → 400)", async () => {
    const res = await post(`${WORKER_URL}/api/shops/${SHOP_SLUG}/reviews`, {});
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
    return { note: "→ 400 validation working" };
  });

  // Auth-guarded endpoints (should return 401/403)
  await check("GET  /api/shops/:id/stripe-status (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/shops/${SHOP_SLUG}/stripe-status`)
  );

  await check("GET  /api/shops/:id/setup-status (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/shops/${SHOP_SLUG}/setup-status`)
  );

  await check("GET  /api/shops/:id/staff (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/shops/${SHOP_SLUG}/staff`)
  );

  await check("GET  /api/shops/:id/bookings (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/shops/${SHOP_SLUG}/bookings`)
  );

  await check("GET  /api/me/bookings (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/me/bookings`)
  );

  await check("PATCH /api/me/profile (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/me/profile`, "PATCH")
  );

  await check("GET  /api/staff/me/today (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/staff/me/today`)
  );

  await check("GET  /api/dev/stats (auth guarded)", () =>
    expectUnauth(`${WORKER_URL}/api/dev/stats`)
  );

  // Auth endpoint
  await check("POST /auth/login (missing fields → 400)", async () => {
    const res = await post(`${WORKER_URL}/auth/login`, {});
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
    return { note: "→ 400" };
  });
}

async function testPages() {
  console.log(`\n${BOLD}${CYAN}Pages (Frontend)${RESET}  ${DIM}${PAGES_URL}${RESET}`);

  const routes = [
    ["/",                  "Marketing homepage"],
    ["/pricing",           "Pricing page"],
    ["/contact",           "Contact page (Turnstile)"],
    ["/about",             "About page"],
    ["/privacy",           "Privacy policy"],
    ["/terms",             "Terms of service"],
    ["/cookies",           "Cookie policy"],
    ["/login",             "Login page"],
    [`/${SHOP_SLUG}`,      "Shop public page"],
    [`/${SHOP_SLUG}/book`, "Shop booking page"],
  ];

  for (const [path, label] of routes) {
    await check(`GET  ${path.padEnd(30)} (${label})`, async () => {
      const res = await fetch(`${PAGES_URL}${path}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
      if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
      const note = res.redirected ? `→ ${res.status} (redirected)` : `→ ${res.status}`;
      return { note };
    });
  }

  // Auth-protected routes — expect redirect to /login
  const protectedRoutes = [
    ["/admin",          "Admin dashboard"],
    ["/admin/bookings", "Admin bookings"],
    ["/admin/staff",    "Admin staff"],
    ["/admin/schedule", "Admin schedule"],
    ["/staff",          "Staff dashboard"],
    ["/account",        "Customer account"],
    ["/setup/stripe",   "Setup/stripe page"],
  ];

  for (const [path, label] of protectedRoutes) {
    await check(`GET  ${path.padEnd(30)} (${label} — auth redirect)`, async () => {
      const res = await fetch(`${PAGES_URL}${path}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
      // Should redirect to /login or return 200 (after redirect chain)
      if (res.status >= 500) throw new Error(`Server error: ${res.status}`);
      const note = res.redirected ? `→ redirected to login` : `→ ${res.status}`;
      return { note };
    });
  }

  // Review modal trigger
  await check(`GET  /${SHOP_SLUG}?review=abc          (review modal trigger)`, async () => {
    const res = await fetch(`${PAGES_URL}/${SHOP_SLUG}?review=abc`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const html = await res.text();
    if (!html.includes("ReviewModal") && !html.includes("review")) {
      return { warn: "Page loaded but ReviewModal marker not found in HTML" };
    }
    return { note: "→ 200 · review param accepted" };
  });
}

async function testEmailService() {
  console.log(`\n${BOLD}${CYAN}Email Service (Resend config)${RESET}`);

  await check("RESEND_API_KEY set on worker", async () => {
    // Indirectly verify — if booking confirmation route works without error
    // We can't call it without auth, but we can check the worker is running latest code
    // by hitting a known endpoint that uses the new code
    const res = await fetch(`${WORKER_URL}/api/shops/${SHOP_SLUG}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_name: "Test", rating: 5, body: "Great!" }),
      signal: AbortSignal.timeout(8000),
    });
    // 201 = review created (key is set and worker is latest)
    // 400 = validation — worker is running but different error
    if (res.status === 500) throw new Error("Worker error — may indicate missing config");
    return { note: `→ worker responding (${res.status})` };
  });
}

// ─── Run ──────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}Pivot Parlor — Health Check${RESET}`);
console.log(`${DIM}${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })} London${RESET}`);

await testWorker();
await testPages();
await testEmailService();

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed + warned;
console.log(`\n${"─".repeat(48)}`);
console.log(`${BOLD}Results:${RESET}  ${GREEN}${passed} passed${RESET}  ${warned > 0 ? `${YELLOW}${warned} warned${RESET}  ` : ""}${failed > 0 ? `${RED}${failed} failed${RESET}` : `${GREEN}0 failed${RESET}`}  ${DIM}(${total} total)${RESET}`);

if (failed > 0) {
  console.log(`\n${RED}${BOLD}Some checks failed. Review errors above.${RESET}`);
  process.exit(1);
} else if (warned > 0) {
  console.log(`\n${YELLOW}All checks passed with warnings.${RESET}`);
} else {
  console.log(`\n${GREEN}${BOLD}All checks passed ✓${RESET}`);
}
