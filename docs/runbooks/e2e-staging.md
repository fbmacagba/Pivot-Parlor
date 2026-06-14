# Runbook: Running E2E against staging

Playwright E2E tests create real shops/bookings/accounts, so they MUST run against
**staging**, never production (the Playwright config refuses to default to prod).
Status (2026-06-14): the stable subset runs **12/12 green** against staging.

## Prerequisites

- **Staging worker** — `pivot-parlor-api-staging.bmorris0565.workers.dev` (D1 `pivot-parlor-db-staging`, `E2E_FIXTURES=true`, dev account seeded).
- **Staging frontend** — a Pages preview of `apps/web` pointing at the staging worker. Deploy it like this (the only change vs prod is `API_URL` + a host-only cookie):
  ```bash
  cd apps/web
  # temporarily point the app at staging (revert right after):
  #   [vars] API_URL = "https://pivot-parlor-api-staging.bmorris0565.workers.dev"
  #   [vars] APP_DOMAIN = "localhost"   # forces a host-only cookie that works on *.pages.dev
  rm -rf build .pages-dist && npm run build && node scripts/prepare-pages-deploy.mjs
  npx wrangler pages deploy ./.pages-dist --project-name=pivot-parlor-web --branch=staging --commit-dirty=true
  git checkout wrangler.toml   # REVERT so prod config never lingers
  ```
  Result: `https://staging.pivot-parlor-web.pages.dev`.
  - **Why `APP_DOMAIN=localhost`:** `sessionCookieHeaders` sets `Domain=.pivotparlor.com; Secure` only when `isProd`. On a `*.pages.dev` host that cookie is rejected and login loops. `localhost` → host-only cookie that works.
- **`.env`** (gitignored): `E2E_BASE_URL=https://staging.pivot-parlor-web.pages.dev` and `DEV_PASSWORD=<staging dev password>`.

## Verify the frontend really talks to staging (do this before any data-creating run)

Staging and prod use different `JWT_SECRET`s, so a token issued by one is rejected by the other:
```
log in via the preview → take the pp_session token → it must be 200 on the staging /auth/me and 401 on prod /auth/me
```
If it's 200 on prod, STOP — the frontend is pointed at production and the tests would pollute it.

## Running

```bash
npx playwright test tests/e2e/dev-login.spec.ts tests/e2e/shop-onboarding.spec.ts tests/e2e/stripe-payment.spec.ts --workers=1
```

- **`--workers=1` is required.** The single staging worker can't take the full parallel fan-out, and several specs share staging DB state (e.g. the stripe "unpaid shop" assertions). Serial = reliable; the subset runs in ~30s.
- **Start from a clean staging.** The specs create shops without cleaning up. Reset first with the cleanup script (deletes `e2e-*` shops only; defaults to the staging worker):
  ```bash
  node scripts/cleanup-e2e-shops.mjs            # staging (default), DEV_PASSWORD from .env
  node scripts/cleanup-e2e-shops.mjs --dry-run  # list targets without deleting
  ```
  The same script cleans prod junk with `API_BASE=https://api.pivotparlor.com node scripts/cleanup-e2e-shops.mjs --allow-prod` (the `--allow-prod` flag is required for any `*.pivotparlor.com` host).

## Login rate-limit bypass (why a worker change was needed)

`/auth/login` has a brute-force brake (5/15min per email+IP, NFR-S4). The suite logs in per test and blew through it → `429`s that looked like flaky failures.

The bypass is **double-gated** so it can't weaken real security: `apps/worker/src/routes/auth.ts` skips the brake only when **both** `E2E_FIXTURES==="true"` (staging) **and** the request carries `X-E2E-Test-Mock: 1` (via the existing `e2eMockAllowed` helper). Plumbing:

- Playwright sends the header on every request (`playwright.config.ts` → `use.extraHTTPHeaders`).
- The BFF login action forwards it to the Worker (`apps/web/app/routes/login.tsx` → `createApiClient(..., { "X-E2E-Test-Mock": … })`).

So **anonymous traffic to the staging login URL (no header) stays fully rate-limited**, and production (`E2E_FIXTURES` unset) ignores the header entirely — the brake is always active there. Verified: 8 header-less logins → `200×5` then `429`; 8 header-bearing logins → all `200`.

## Spec status

- **Stable (run in CI):** `dev-login`, `shop-onboarding`, `stripe-payment` — 12 tests, green. (`stripe-payment` uses the `X-E2E-Test-Mock*` fixture headers, so no real Stripe is needed.)
- **Excluded from the stable run:**
  - `site-generation.spec.ts` — drives the real AI workers (builder/research/text/images) end to end: slow and burns AI credits. Run manually when validating generation.
  - `dev-shop-delete-repro.spec.ts` — a headed debugging repro, not a regression guard.

## Resolved: production was polluted by past E2E runs

Production held 22 `e2e-*` shops created by E2E runs that targeted prod before this staging setup existed. **Cleaned 2026-06-14** (backup `pivot-parlor-db-backup-precleanup-20260614.sql` first; only `ferdyms-barber-shop` remained; zero orphan child rows) via `API_BASE=https://api.pivotparlor.com node scripts/cleanup-e2e-shops.mjs --allow-prod`. Now that E2E only targets staging, this should not recur.

## CI job (wired)

`.github/workflows/e2e.yml` automates the whole flow as a **pre-merge PR gate** (PR code → staging → test, not a post-merge smoke test):

1. Deploy the PR's worker to staging (`wrangler deploy --env staging`) + run staging D1 migrations.
2. Rewrite `apps/web/wrangler.toml` to staging (`scripts/ci-set-web-staging-vars.mjs`), build, and deploy the PR's frontend to the `staging` Pages preview branch (preview-scope vars — never touches production).
3. Reset staging (`scripts/cleanup-e2e-shops.mjs`) → run the stable subset with `--workers=1` → upload the Playwright report artifact.

**How to run it:** add the **`e2e` label** to a PR (or trigger it manually via the Actions tab → "E2E (staging)" → Run workflow). New commits to a labeled PR re-run it; remove the label to stop. A `concurrency` group serializes runs so the single shared staging worker/DB is never hit by two runs at once.

**Required repo secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DEV_PASSWORD` (all set). `E2E_BASE_URL` + `API_BASE` are hardcoded in the workflow env (the fixed staging URLs), not secrets.
