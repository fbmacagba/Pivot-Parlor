# Pivot Parlor Remediation — Master Task List

> **For agentic workers:** This is the approved master backlog from the 2026-06-12 code review. Before executing a phase, author a detailed implementation plan for that phase per `superpowers:writing-plans` (exact code, TDD steps, commits), then execute via `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Do not start any phase without user approval of this list.

**Goal:** Close every security, integrity, CI, and quality gap found in the June 2026 review, in risk order, without regressing live behavior.

**Architecture:** Surgical fixes to the existing Remix BFF + Hono Worker + D1 stack. No rewrites. Each phase lands independently and leaves the platform deployable.

**Tech stack:** Remix (Cloudflare Pages), Hono (Cloudflare Workers), D1/KV/R2/Queues, Playwright, vitest (new), zod (new).

**Traceability:** Each task references the PRD non-functional requirement it satisfies ([docs/PRD.md §9](../../PRD.md)).

**Status legend:** `[ ]` pending · `[x]` done

---

## Phase 0 — Prep & safety nets (do first, enables everything else)

- [ ] **T0.1 Branch + baseline.** Create `remediation/phase-1` style branches per phase off the default branch; confirm `npm run build` passes at baseline so regressions are attributable.
- [ ] **T0.2 Rotate exposed secrets.** `JWT_SECRET` and `DEV_PASSWORD` sit in plaintext in local `.env` (and the dev password follows a guessable pattern). Rotate both: new `JWT_SECRET` via `wrangler secret put` (Worker + Pages), new strong `DEV_PASSWORD`, update local `.env`. *Note: rotating JWT_SECRET logs out all sessions — schedule accordingly.* (NFR-S6)
- [ ] **T0.3 Add `.env.example`** with keys but no values; document in README (already referenced). (NFR-S6)
- [ ] **T0.4 Unit test harness.** Add vitest + `@cloudflare/vitest-pool-workers` to `apps/worker`; wire `npm test` into turbo. One smoke test to prove the harness runs. All later fixes get tests here. (NFR-Q2)

## Phase 1 — Critical security holes (attack-order #1)

- [ ] **T1.1 Remove developer bootstrap takeover.** `apps/worker/src/routes/auth.ts:52-66` — delete the first-login auto-creation of `dev@pivotparlor.com`. Replace with a one-time seed (migration or gated script `scripts/reset-dev-password.mjs` path) so the account always exists. Test: login with unknown email + that address returns 401, never creates a user. (NFR-S3)
- [ ] **T1.2 Fix schedule IDOR.** `apps/worker/src/routes/schedule.ts:30-34` — `GET /:staffId` must 404 unless the staff row's `shop_id` matches the `:shopId` path param. Test: admin of shop A requesting shop B staff gets 404. (NFR-S1)
- [ ] **T1.3 Fix waitlist IDOR.** `apps/worker/src/routes/waitlist.ts:56-68` — `PATCH /:id/status` must verify the waitlist entry's `shop_id` matches the caller's shop (or caller is developer) before updating. Test as above. (NFR-S1)
- [ ] **T1.4 Audit remaining routes for the same pattern.** Sweep every route that loads a row by bare `id` (`bookings`, `staff`, `services`, `invites`, `walkin`) and confirm shop-scoping; fix any further instances found. (NFR-S1)
- [ ] **T1.5 Gate E2E backdoor fixtures.** `apps/worker/src/db/queries.ts:247-253` — the predictable Playwright invite token (64×`a`) and fixture rows must only activate when an `E2E_FIXTURES=true` Wrangler var is set (never set in prod). (NFR-S3)

## Phase 2 — Booking integrity (attack-order #2)

- [ ] **T2.1 Migration 018: unique slot index.** Partial unique index on `bookings(staff_id, booking_date, start_time)` excluding `status IN ('cancelled','no_show')`. Pre-flight: query prod for existing duplicate rows and resolve before applying. (NFR-R1)
- [ ] **T2.2 Handle constraint violation as 409.** `apps/worker/src/routes/bookings.ts:126-134` — keep the friendly pre-check, catch `UNIQUE constraint failed` on INSERT, return `{ success:false, error:"Slot no longer available" }` 409. Unit test: two inserts for the same slot → one success, one 409. (NFR-R1)
- [ ] **T2.3 Validate `start_time` before date math.** Same route — reject unparseable dates with 400 (currently throws → 500 via `toISOString`). (NFR-R4)

## Phase 3 — CI gates + existing type errors (attack-order #3)

- [ ] **T3.1 Fix the 23 TS2339 errors** in `apps/worker/src/routes/{dashboard,shops,walkin}.ts` (union-type narrowing). No behavior change; `npx tsc --noEmit` clean. (NFR-Q1)
- [ ] **T3.2 Add gates to deploy workflows.** Both `.github/workflows/deploy-{web,worker}.yml`: run `check-types`, `lint`, and unit tests before build/deploy; fail the deploy on any failure. (NFR-Q1)
- [ ] **T3.3 Fix `turbo.json` lint task** — add `"dependsOn": ["^lint"]`; ensure every workspace has a working `lint` script. (NFR-Q1)
- [ ] **T3.4 First real unit tests.** Port slot-calculation (`services/slots.ts`) and booking-conflict logic into vitest coverage as the regression baseline. (NFR-Q2)

## Phase 4 — Session & OAuth hardening (attack-order #4)

- [ ] **T4.1 Enforce session revocation.** `apps/worker/src/middleware/auth.ts:43-56` — after JWT verify, `KV.get("session:"+token)`; missing → 401. Makes logout (`auth.ts:81-85`) actually work. Test: login → logout → reuse token → 401. (NFR-S2)
- [ ] **T4.2 OAuth open-redirect fix.** `apps/worker/src/routes/oauth.ts:184,239,299` — only allow `redirectTo` that starts with `/` and not `//`; otherwise fall back to role dashboard. (NFR-S5)
- [ ] **T4.3 OAuth state hardening.** `oauth.ts:11-21` — add random nonce + 10-minute expiry to state; reject expired/garbled state. (NFR-S5)
- [ ] **T4.4 Rate limiting.** KV-counter middleware: login (5/15min per email+IP), AI generation endpoints (10/hr per user), public contact + booking creation (sane per-IP caps). Return 429 with the standard envelope. (NFR-S4)
- [ ] **T4.5 Security headers middleware** on the Worker (and Pages headers file): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (except embeddable widget routes later), `Strict-Transport-Security`. (NFR-S7)
- [ ] **T4.6 OAuth email-verified check.** Only auto-create/link accounts when the provider asserts a verified email (Google `email_verified`, etc.). (NFR-S5)

## Phase 5 — Environments & migration discipline (attack-order #5)

- [ ] **T5.1 Migration tracking table.** `schema_migrations(name, applied_at)`; script `scripts/migrate.mjs` applies pending `migrations/*.sql` in order, records each, idempotent. (NFR-R5)
- [ ] **T5.2 CI applies migrations** via the script on worker deploy (replaces the current schema.sql-only step). (NFR-R5, NFR-Q1)
- [ ] **T5.3 Own `shop_settings` in main schema.** Migration creating `shop_settings` (matching `apps/workers/booking/src/db/ensure-schema.ts:30`), so the API no longer depends on a sibling worker having run; demote worker `ensure-schema` to no-op/verify. (NFR-R5)
- [ ] **T5.4 Staging environment.** Wrangler `[env.staging]` for worker + workers with separate D1/KV namespaces; staging Pages project or preview branch env. Document promotion flow in README. (NFR-Q3)
- [ ] **T5.5 E2E safety.** `playwright.config.ts`: **fail** when `E2E_BASE_URL` is unset (no prod default); point local `.env` at staging; CI runs E2E against staging only. (NFR-Q3)
- [ ] **T5.6 Fix CLAUDE.md drift** (migration count, new migration runbook, staging + test commands). (NFR-Q1)

## Phase 6 — Reliability & correctness

- [ ] **T6.1 Reminder queue delivery.** `apps/worker/src/index.ts:254-257` — stop ack-dropping future `sendAt` messages; use queue `delaySeconds` on send (`bookings.ts:188`) and `msg.retry({delaySeconds})` as fallback. Test the scheduling math. (NFR-R3)
- [ ] **T6.2 Fix poisoned `ensureSchema` promise cache** in `apps/workers/booking/src/index.ts:13-20` and `apps/workers/chatbot/src/index.ts:145-150` — clear the cached promise on rejection so the next request retries. (NFR-R4)
- [ ] **T6.3 Global ErrorBoundary** in `apps/web/app/root.tsx` + friendly error component; per-layout boundaries for `admin`, `dev`, `staff`, `$shopSlug`. (NFR-R4)
- [ ] **T6.4 Defensive loaders.** Wrap the ~10 unprotected `api.get` loader calls (e.g. `account.tsx:21`, `admin.revenue.tsx`) with try/catch returning error state the UI renders. (NFR-R4)
- [ ] **T6.5 Safe JSON parsing.** `safeJsonParse` helper in `@repo/utils`; replace the 12 bare `JSON.parse` calls on KV/DB content in `shops.ts`, `ai.ts`, `slots.ts`. (NFR-R4)
- [ ] **T6.6 Timezone correctness.** Use `shops.timezone` (exists in types, unused) in slot computation `apps/worker/src/services/slots.ts:63` and booking validation; unit tests covering BST boundary dates (last Sunday of March/October). (NFR-R2)

## Phase 7 — Consistency & shared code

- [ ] **T7.1 Adopt zod.** Schemas in `@repo/utils` (or new `@repo/schemas`) for booking, auth, contact, services, schedule payloads; validate at route edges; consistent 400s. (NFR-Q4)
- [ ] **T7.2 Reconcile `@repo/types` with reality.** Align `BookingStatus` (schema CHECK vs type union incl. `in_progress`), `Booking` field names (`amount`/`customer_name`), and use shared types in worker + web. (NFR-Q4)
- [ ] **T7.3 De-duplicate utilities.** Import `addMinutes`/`rangesOverlap` from `@repo/utils` in `services/slots.ts` and `routes/bookings.ts`; delete local copies. (NFR-Q4)
- [ ] **T7.4 Unify BFF API access.** Migrate the 23 raw-`fetch` proxy routes to `createApiClient` (extend it for pass-through/status-preserving cases). (NFR-Q4)
- [ ] **T7.5 Standardize loader/action envelopes** to `{ success, data?, error? }` across routes currently returning `{ok}`/bare shapes (`admin.staff`, `admin.settings`, `admin.bookings`, `$shopSlug.waitlist`, …). (NFR-Q4)
- [ ] **T7.6 FK hygiene migration.** Add `ON DELETE` actions for `bookings.staff_id`, `waitlist.staff_id`; FK for `contacts.shop_id` (D1 caveat: table-rebuild pattern for SQLite). (NFR-R5)
- [ ] **T7.7 Split `dev.shops.tsx`** (1,780 lines) into shop list + AI config routes/components. No behavior change; E2E covers it.

## Phase 8 — Hygiene, DX & polish

- [ ] **T8.1 Kill the `.js` twin footgun.** `clean:js` script removing `apps/web/app/**/*.js`; run automatically in `predev`/`prebuild`; delete the 5 currently-stale twins (incl. `admin.settings.js`, `api.me.bookings.js`).
- [ ] **T8.2 Untrack `test-results/.last-run.json`**; add `test-results/` to `.gitignore`.
- [ ] **T8.3 Repo root cleanup.** Move the three `pivot-parlor-task-list-2026-03-*.md` files to `docs/archive/`; delete `apps/workers/chatbot/src/_session_query_patch.ts.bak`.
- [ ] **T8.4 Pagination** (limit/offset params, default 50) for admin/dev list endpoints currently hard-capped at `LIMIT 100` (`contact.ts:79`, invites, staff).
- [ ] **T8.5 Update wrangler `compatibility_date`** across all 9+ configs to a current date; smoke-test each worker after bump.
- [ ] **T8.6 Error-log context.** `app.onError` (`index.ts:167-170`) logs method + path; structured log for contact route instead of dumping raw body.
- [ ] **T8.7 Parallelize `admin.staff.tsx` loader** fetches (`Promise.all`).
- [ ] **T8.8 BFF auth latency (investigate, optional).** Evaluate verifying the JWT locally in the BFF (shared secret already exists) vs the per-request `/auth/me` round-trip; only adopt if revocation semantics from T4.1 are preserved (e.g. short local-verify TTL + KV check on Worker).

---

## Explicitly deferred (not in this remediation)

- CSRF synchronizer tokens (SameSite=Lax + Bearer pattern gives baseline cover; revisit with the embeddable widget in Phase 2 roadmap).
- Template component de-duplication (intentional per-template styling; cost > benefit).
- Native unit tests for `apps/web` UI components (E2E + boundaries cover the risk for now).
- Contact-form CAPTCHA (rate limiting in T4.4 first; add Turnstile if spam appears).

## Verification gates (every phase)

1. `npm run check-types && npm run lint` clean at repo root.
2. Unit tests green (`apps/worker`), Playwright green **against staging** (from Phase 5 onward).
3. `npm run verify:live` smoke after each production deploy.
4. Each phase = one PR; no phase starts before the previous phase's PR is merged or explicitly waived.
