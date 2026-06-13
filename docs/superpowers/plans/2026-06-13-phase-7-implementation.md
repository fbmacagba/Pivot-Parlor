# Phase 7 — Consistency & Shared Code (scoped)

**Branch:** `remediation/phase-7` (stacked on `remediation/phase-6`).

Phase 7's master-list items varied widely in value and risk once investigated. This phase ships the safe, high-value subset; the rest is declined or deferred with reasons (the codebase has **no web test harness**, so behavioral regressions in web refactors aren't catchable by tsc/lint/build, and Phase 6 showed how easily those slip in).

## Shipped

- **T7.3 De-dup utilities** — `slots.ts` and `bookings.ts` import `addMinutes`/`rangesOverlap` from `@repo/utils` (3 copies → 1). Tested by the existing 73-test suite.
- **T7.2 (corrected scope)** — `@repo/types` is the frontend camelCase contract, intentionally distinct from the worker's snake_case `DB*` row interfaces; documented inline rather than "fixed" (the field-name divergence is by design). Fixed the genuinely-wrong `StaffAvailability.dayOfWeek` comment ("0=Sunday" → Monday-first, matching the bug fixed in #6).
- **`in_progress` booking status (real broken feature)** — staff "mark in progress" 500'd on the CHECK constraint. `schema.sql` now allows it (fresh DBs correct, test added); existing DBs fixed via an operator-gated, staging-validated, backup-first rebuild ([runbook](../../runbooks/bookings-status-fk-rebuild.md)) — decoupled because **D1 enforces FKs** (verified) so a careless `DROP TABLE bookings` would cascade-delete child rows.

## Declined

- **T7.4 Unify the 23 raw-`fetch` BFF routes onto `createApiClient`** — **declined as specified.** Those routes are deliberate: `buildWorkerUpstreamHeaders` forwards the browser `Cookie` (Cloudflare Access), falls back to the session JWT, injects E2E headers, and `workerResponseLooksLikeJson` guards non-JSON upstreams. `createApiClient` does none of this. Forcing the migration would delete load-bearing behavior and likely introduce auth/proxy bugs. The duplication is real but the right fix is a shared proxy helper, not `createApiClient` — a future task.

## Deferred (need E2E smoke coverage against staging first)

- **T7.5 Standardize loader/action envelopes** — high churn across web routes whose components read the current shapes; behavioral risk tsc/build won't catch.
- **T7.7 Split `dev.shops.tsx` (1,780 lines)** — valuable, but a Remix route split can subtly change which loader/action serves a request and form-action targets; no runtime verification today.
- **T7.1 zod validation** — lowest-payoff "DO" item; strict validation on the revenue-critical public booking endpoint risks rejecting a payload shape the frontend actually sends. The hand-rolled validation already works.

**Recommended follow-up:** add Playwright E2E smoke tests against the Phase 5 staging environment (admin/dev/staff/booking happy paths), then do T7.5 + T7.7 behind that safety net, and build the shared BFF-proxy helper for T7.4's underlying duplication.

## FK hygiene (T7.6) — reviewed, mostly a non-issue

D1 enforces FKs, but the bookings FK "gaps" are correct as-is: `staff_id`/`service_id` stay RESTRICT so removing a staff member or service never wipes booking/revenue history; `shop_id` already cascades intentionally. The only genuine gap is `contacts.shop_id` having no FK — low value (enquiry log), deferred. The rebuild script preserves all FK definitions exactly.
