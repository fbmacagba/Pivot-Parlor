# Portfolio demonstration cleanup

Approved scope: make the supplied FerdyM shop credible as a clearly labelled portfolio demonstration, without changing its live database records.

## Design and boundaries

- Only `ferdyms-barber-shop-014` is reserved as this portfolio demonstration. Exact server-owned identity checks; no request flag can put another shop into demo mode.
- Serve a synthetic public presentation for this slug: Classic haircut, Clipper cut and Restyle & finish; sample team; no reviews, fabricated ratings, personal phone or address.
- Keep the existing dark/green shop identity. Use a compact typographic hero; label the example before the main content. Correct the landing and booking titles.
- The existing five-step booking interface uses synthetic services, staff and times. Sample guest details are supplied. Completion is browser-local, clearly says no appointment was booked, and sends no booking/payment/email request.
- Refuse direct demo booking submissions in the Remix action and canonical booking Worker, including callers using the original tenant ID. Public waitlist/queue writes for this shop are refused too.
- Show explicitly labelled scripted sample assistant replies in the demo browser; do not send demo messages to the live chatbot.
- Measure the cookie notice height and lift chat controls above it, preserving their keyboard accessibility.
- Keep normal tenants on their existing loader, booking and chatbot paths.

## Validation

1. Regression tests for exact demo identity, fixture privacy/truthfulness, synthetic slot selection and server refusal of ID/slug booking attempts.
2. Web, API and booking-worker tests and typechecks; frontend build and lint. No tests against production.
3. Two bounded local desktop/mobile passes: labels, review absence, service/team names, compact hero, cookie/chat separation, booking completion with no writes, sample assistant and descriptive titles.
4. Preserve the original records. No production configuration/data changes, PR merge or deployment without review.

## Dependency and gate review

Compatible security updates move Remix 2.17.4 to 2.17.5, Hono 4.13.9 to 4.13.16, Express 4.22.1 to 4.22.3 and proxy-addr 2.0.7 to 2.0.8. Direct package names were validated before installation. The production audit is reduced from nine findings to seven (five high and two moderate, zero critical); older-router warnings remain and require a separately scoped framework migration. Full audit also includes development-tool findings, including the repository's previously accepted tar exception. This change does not add a tar exception or force incompatible transitive versions.

The new runtime finding `8388725651490be87c8df3728df8156d5334236bc43ead218306c4fdbceb99af` is propagated only from turbo-stream. The [upstream advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-rxv8-25v2-qmq8) explicitly limits the Remix exposure to Single Fetch. This app uses classic data requests; `v3_singleFetch: false` is now explicit in Vite configuration. A scoped Aramid override records that evidence and must be reassessed before enabling Single Fetch or migrating the framework. It does not suppress the other router warnings.

The pre-commit scan budget increases from five to thirty seconds so the Windows inline scanner can finish; no scanner is disabled. A root ESLint entry point applies the existing shared rules to gate-invoked source files, fixing the previous missing-root-config crash. Its probe passes with zero warnings; an unused walk-in import exposed by the repaired integration was removed.

## Completed verification (2026-11-04)

- Web: full suite 271 tests passed. All workspace typechecks, lint, tests and builds passed after the dependency updates.
- Main API: 316 tests passed. Booking Worker: 105 tests passed. Chatbot Worker: seven tests passed. Main API and booking Worker typechecks passed.
- Frontend production build passed. The Vite development server encountered a React CommonJS loading error; browser verification used the built Pages app instead, with `API_URL` bound to localhost and all external browser requests blocked.
- Confirmed at 320, 390, 768 and 1440 pixels: no horizontal overflow, chat launcher clear of the cookie notice. Reopened notice received keyboard focus; demo menu omitted account sign-in.
- Completed the five-step booking walkthrough using sample guest details, and tested reset. Scripted chat returned sample services/team replies. These browser interactions generated zero write requests and zero external requests, with no uncaught page errors.
- Direct booking POST and waitlist action data POST returned 403. The ordinary waitlist document POST is redirected by loader revalidation to the safe booking page. Demo confirm, waitlist and walk-in GETs redirect to the walkthrough.
- API regression tests verify refusal of the original tenant ID and slug, with zero booking, waitlist and walk-in rows created. Existing normal-tenant acceptance tests also passed.

## Release notes

No migrations or changes to live tenant records are required. The original shop records remain intact, while this exact public slug renders a synthetic example. Other tenants retain their live booking and model paths; the responsive header and cookie/chat separation improvements are shared.

This is evidence of website and booking-flow implementation. The sample assistant is explicitly scripted and must not be presented as evidence of live model performance or measured client results.

Deploy and verify the main API and booking Worker guards before publishing the frontend. The authorized release should wait for the normal pre-push and PR checks, then deploy the guards from the reviewed branch before merging. This avoids publishing the public demonstration before its canonical API refusals are active. No migration is added by this change. Keep the remaining framework findings visible as follow-up security work.
