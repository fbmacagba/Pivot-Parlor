# Phase 8 — Hygiene, DX & Polish

**Branch:** `remediation/phase-8` (stacked on `remediation/phase-7`).

## Shipped

- **T8.1 `.js` twin footgun** — already fixed in Phase 0 (`clean-app-js.mjs` in `predev`/`prebuild`). No action.
- **T8.2 test artifacts** — untracked `test-results/.last-run.json`; gitignore `test-results/` + `playwright-report/`.
- **T8.3 repo root** — archived the three `pivot-parlor-task-list-2026-03-*.md` to `docs/archive/`; deleted `apps/workers/chatbot/src/_session_query_patch.ts.bak`.
- **T8.4 pagination** — `GET /api/contact` takes `limit`/`offset` (default 100 = the prior fixed cap so callers are unchanged; max 200), making enquiries beyond the first 100 reachable. Regression test added. The per-shop list endpoints (staff/services/schedules) were intentionally left unbounded — they're small and adding a cap would risk silently truncating UIs.
- **T8.5 compat dates** — aligned all 9 worker/Pages configs + the worker dev/vitest configs from 2024-09-23/2024-10-22 to **2025-06-01**. Inert until deploy; the main worker was deployed to staging and smoke-tested (login + security headers OK), and the vitest runtime uses the new date so the 76-test suite validates worker code on it. **The 7 background workers deploy independently with no staging env — smoke-test each on its next deploy.**
- **T8.6 error-log context** — `app.onError` logs `method path` with the error; the contact route logs structured fields instead of the raw PII/message body.
- **T8.7 parallel loader** — `admin.staff.tsx` fetches staff + services concurrently (`Promise.allSettled`) instead of serially.

## T8.8 BFF auth latency — investigated, NOT changed (recommend keep current)

Every protected BFF loader calls `GET /auth/me` on the Worker before fetching data, adding a round-trip. The tempting optimization is to verify the JWT locally in the BFF (the `JWT_SECRET` is shared). **Recommendation: do not adopt as-is.** Phase 4 (T4.1) made session revocation real by requiring a live `session:<token>` KV record on every authenticated request — local JWT verification in the BFF would bypass that, reintroducing the "stolen/[logged-out] token still works" hole the remediation just closed. A safe version would need the BFF to still consult KV (no latency win) or accept a short revocation window via a brief local-verify cache. The round-trip is the cost of immediate revocation; keep it unless profiling shows it's a real bottleneck, in which case implement the cached-verify-with-KV-fallback variant deliberately.

## Verification
76/76 worker tests, `tsc`/`lint`/`build` clean, staging worker redeployed and smoke-tested on the new compat date.
