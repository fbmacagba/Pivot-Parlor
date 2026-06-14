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
- **Start from a clean staging.** The specs create shops without cleaning up. Reset first by logging in as dev and `POST /api/shops/:id/delete` for each shop (see the reset snippet used during setup).

## Login rate-limit bypass (why a worker change was needed)

`/auth/login` has a brute-force brake (5/15min per email+IP, NFR-S4). The suite logs in per test and blew through it → `429`s that looked like flaky failures. `apps/worker/src/routes/auth.ts` now skips that rate limit **only when `E2E_FIXTURES==="true"`** (staging). Production leaves `E2E_FIXTURES` unset, so the brake stays fully active there.

## Spec status

- **Stable (run in CI):** `dev-login`, `shop-onboarding`, `stripe-payment` — 12 tests, green. (`stripe-payment` uses the `X-E2E-Test-Mock*` fixture headers, so no real Stripe is needed.)
- **Excluded from the stable run:**
  - `site-generation.spec.ts` — drives the real AI workers (builder/research/text/images) end to end: slow and burns AI credits. Run manually when validating generation.
  - `dev-shop-delete-repro.spec.ts` — a headed debugging repro, not a regression guard.

## Known issue: production was polluted by past E2E runs

Production currently holds ~22 `e2e-*` shops (e.g. `e2e-luxury-…`, `e2e-test-shop-…`, `e2e-design-notes-…`, `e2e-logo-upload-…`) created by E2E runs that targeted prod before this staging setup existed. They are test junk and should be cleaned (keep real shops such as `ferdyms-barber-shop`). Clean via dev-authenticated `POST /api/shops/:id/delete` for each `e2e-*` slug, backup-first.

## Suggested CI job (not yet wired)

A CI E2E job would: deploy a staging frontend from the PR's code → reset staging shops → run the stable subset with `--workers=1` → tear down. It needs `E2E_BASE_URL` + `DEV_PASSWORD` as repo secrets. Left as a follow-up.
