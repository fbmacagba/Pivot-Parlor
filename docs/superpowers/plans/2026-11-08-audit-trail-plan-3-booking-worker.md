# Audit Trail, Plan 3 of 4: Booking Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every state-changing route and the cron of the booking worker (`apps/workers/booking`) write their own audit entries under the spec's refuse-on-failure rule. The 7 API routes that only forward to it then become exempt, so both workers end at `PENDING_CEILING = 0`.

**Architecture:**
- The booking worker gets the same audit glue the API worker has. It is a request id, a recorder per request, a gap guard that reads a coverage registry, and a coverage test.
- Each route then supplies only its action, entity and allow-listed changes.
- Most booking routes interleave Stripe calls with several separate writes and compensations. They use a started/outcome pair (`run()`) around the existing body rather than being rewritten into one batch.
- The three "cancel an unpaid deposit booking" paths become one guarded batch that holds the change and its entry, as PR #125 did for inventory.

**Tech Stack:** Cloudflare Workers (Hono 4), D1, KV, Stripe REST (faked in tests by `outboundService`), `@cloudflare/vitest-pool-workers`, TypeScript, Remix (Activity labels only).

**Spec:** `docs/superpowers/specs/2026-09-26-audit-trail-design.md`, especially sections 3.3, 4.3 to 4.6, 8 and 11.

**Predecessors:**
- `docs/superpowers/plans/2026-09-26-audit-trail-foundation.md` (Plan 1);
- `docs/superpowers/plans/2026-11-08-audit-trail-plan-2-api-routes.md` (Plan 2, PR #124);
- PR #125, which superseded Plan 2 Ruling 3 and introduced the guarded-batch technique.

Their Rulings are cited by number.

## Global Constraints

- Refusal response for an audit write failure, verbatim: HTTP 503, `{ "success": false, "error": "Could not record this action; nothing was changed." }` (spec 4.4).
- **Never store, in any audit column:**
  - passwords, tokens (JWT, session), API keys, card data, Stripe event bodies, or full request bodies (spec 3.1);
  - personal data: customer or staff names, email addresses, phone numbers, postal addresses, booking notes, or any free text. Shop name and slug count as personal data (Ruling 17);
  - **Stripe object ids and bearer URLs:**
    - Checkout Session ids and URLs;
    - PaymentIntent ids and `client_secret`s;
    - charge, refund and Connect account (`acct_`) ids;
    - account-link URLs, and caller-supplied `return_url` / `refresh_url`.

    The one exception is the Stripe **event** id (`evt_...`), validated by the `stripeToken` shape exactly as the API worker's webhook does.
- Our own UUIDs (booking, sale, business day, alert, shop) are fine as `entity_id` and in `details`.
- When a personal or free-text field changes, record its **name** in `details.fields`, never its value.
- `reason` and `details` are hashed and locked for 6 years. Put only structured values there (ids, counts, enums, pence amounts, booleans, `HTTP <status>`), never a thrown error's message.
- Money is INTEGER pence. All SQL uses prepared statements with `.bind()`.
- Worker JSON keeps its existing response shapes. Instrumenting a route must not change any status code or body except:
  - the new 503 refusal;
  - the copy fixes listed in decision 12.
- No migration. The next migration number stays `051`.
- Do not use em or en dashes in user-facing text. That covers error strings, the Stripe Checkout product name and the Activity labels.
- Commits:
  - never `--no-verify`;
  - run `aramid check --staged` before each commit;
  - never stage `.aramid/`, `.githooks/`, `.graphite/` or `.impeccable/`;
  - end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The aramid pre-push gate lints test files (`npm run lint` does not). Run `npx eslint <changed files>` including tests before committing. `no-explicit-any` and unused `_x` destructures block the push.
- Do not push, deploy, or touch staging or production data without the owner's go-ahead in the moment.
  - Merging deploys the booking worker, then the API worker, then Pages, through CI. The owner merges.
- `sed -i` rewrites CRLF files as LF in this repo. Edit with the editor tool.
- Tests:
  - booking worker: `cd apps/workers/booking && npm test` (each file gets a fresh simulated D1 replayed from the main worker's `schema.sql` plus migrations, so `audit_log` exists; Stripe is faked by `outboundService` in `vitest.config.ts`);
  - API worker: `cd apps/worker && npm test`;
  - package: `cd packages/audit && npm test`;
  - web: `cd apps/web && npx vitest run app/lib/audit.test.ts`.

  Console output inside worker tests is swallowed, so put diagnostics in assertion messages.

## Decisions made while planning (owner can veto)

1. **"Plan 3" is split in two.** Plan 1 defined Plan 3 as the booking worker *and* the six AI background workers (research, text, chatbot, builder, images, audit). Those are independent subsystems with different shapes:
   - booking is an HTTP surface that moves money;
   - the AI workers are queue consumers whose entries are `ai.call`.

   **This plan is the booking worker plus the 7 API proxies.** Plan 4 covers the AI workers, the builder/images/audit workspace conversions and `origin_actor_ref` consumption.
2. **The booking worker generates its own request id** and ignores any inbound `X-Request-Id`, as the API does (Ruling 6).
   - It cannot tell a service-binding call from the API apart from a public `workers.dev` call, so a header from the API cannot be trusted either.
   - The API's proxy hop becomes exempt and writes nothing, so the booking worker's entry is the record. Its `request_id` is the booking worker's own.
3. **The glue is copied, not shared.**
   - `apps/workers/booking/src/audit/` gets its own `context.ts`, `request-id.ts`, `gap-guard.ts`, `registry.ts` and a copy of `fieldChanges`.
   - `@repo/audit` stays framework-free (spec 4.1), and the two workers' auth shapes differ.
   - This PR changes the API worker's audit glue only in its registry (Task 8).
   - Cost: two copies of `statusOutcome`, `fieldChanges` and the gap-guard rules to keep in step.
4. **Pattern per route** (tables in each task):
   - **B (one batch):** single unconditional changes.
   - **T (`run()`):** routes that call Stripe or make several writes with compensations. Rewriting those into one batch would change their failure behaviour; `run()` wraps the existing body unchanged.
   - **Guarded batch:** the three deposit-abandon paths (Task 4).
5. **Guarded batch for "cancel an unpaid deposit booking"** (`cancelPendingBookingStmts`):
   - The status write is `CASE WHEN status = 'pending' THEN 'cancelled' ELSE NULL END`. On any other status it writes NULL into `bookings.status`, which is NOT NULL, so D1 rolls the whole batch back, the entry included.
   - This keeps the deposit sweep at one D1 batch per booking, its current subrequest budget.
   - **Safety:** `bookings.status` is NOT NULL in `schema.sql`, and in `rebuild-bookings-prod.sql`, which was generated from the live production schema on 2026-06-14. Task 4 adds a startup assertion of exactly that column, so the worker fails closed if it were ever missing. It would then refuse to start, never write a NULL status.
6. **The Stripe webhook uses `run()`, one started/outcome pair per verified event.** This deviates from spec 4.5, which puts the entry in the webhook's own batch, as the API worker's webhook does.
   - The booking webhook's handlers mix `.run()`, batches and conditional updates across five event types, so there is no single batch to join.
   - The started row is written after signature verification and before the `processed_stripe_events` dedupe insert. A 503 therefore leaves Stripe's retry undeduped.
7. **`AuditRunResult` gains `shopId` and `entityType`** (package change, Task 1). A webhook's shop and subject are only known after its handler reads the event. The outcome row uses them; the started row keeps the input's.
8. **The `GET /booking/shops/:shopId/connect/status` write is recorded** (`payment.connect.sync`). It is the only GET handler that writes (all GET handlers were checked by grep while planning), and the coverage test cannot see GETs, so a dedicated test pins it.
   - If its entry cannot be written, the sync is skipped. The GET still answers from the persisted columns, exactly as it does today when Stripe's poll fails. A read is not refused over a background sync.
9. **Side-effect notifications get no entry of their own** (Plan 2 decision 6): the booking confirmation email and the reminder enqueue. Day close's no-show deposit captures are counted in day close's entry.
10. **Booking cancel keeps Plan 2 Ruling 5's split.**
    - The API's deposit-cancel hop (`PUT .../bookings/:bookingId/status`, which calls the booking worker's `/cancel`) keeps its details-only entry.
    - The booking worker's `booking.cancel` entry carries the status change.
    - One cancel therefore shows two linked-by-booking entries, one per worker.
11. **New catalogue actions:**
    - `shop.setup.complete`, `day.open`, `day.close`;
    - `booking.check_in`, `booking.checkout`, `pos.void`;
    - `payment.connect.onboard`, `payment.connect.sync`;
    - `platform.alert.resolve`.

    Walk-in and staff-made bookings reuse `booking.create`, with `details.channel` set to `"online"`, `"staff"` or `"walk_in"`.
12. **Copy fixes on touched handlers** (user-facing dashes):
    - the Stripe Checkout product name becomes `Booking deposit: ${service.name} at ${shop.name}`;
    - two refund errors (Task 7);
    - a no-dashes guard test over booking route `error:` lines (Task 8).

    **Not changed:** the stored sale-line name `${product.name} — ${variant.name}` in `lib/sales-core.ts`. It is persisted data that receipts and reports read, so it is listed as an owner follow-up.
13. **A token whose user row is gone** (the test helper's `user-<role>` subs, or a deleted user's still-valid token) records `actor_ref` with no subject row.
    - `audit_log.actor_ref` has no foreign key, and the subject insert selects from `platform_users`, so it simply inserts nothing.
    - This is the API worker's behaviour too. No test helper change is needed.

## Review Focus

1. **A Stripe redelivery of the same event.** The response stays `{ received: true, duplicate: true }`. The trail shows one `succeeded` outcome with `details.duplicate: true`, never a second payment's changes. Test: Task 7 `"a redelivered event records a duplicate, not a second change"`.
2. **A public deposit booking whose Checkout Session cannot be created** (Stripe down).
   - The response stays 502, and the booking is left `cancelled`.
   - The trail has a `failed` outcome with `reason: "HTTP 502"` and no `succeeded` row.
   - Test: Task 4 `"a deposit booking whose session fails records failed"`.
3. **Personal data leaking into a hashed column** from public bookings, staff bookings, walk-ins and sales:
   - none of the submitted name, email, phone or notes may appear;
   - nor the Checkout URL, the PaymentIntent id, or the shop name.

   Tests: `expectNoPersonalData` in Tasks 4, 5 and 6.
4. **An abandon that loses its race** (the sweep or the expiry webhook already cancelled the booking).
   - The response stays `{ success: true }`.
   - The trail gets a `refused` entry with reason `not_pending`, never a second `succeeded` cancel.
   - The sweep skips that booking and carries on.
   - Tests: Task 4 `"abandon after the sweep cancelled records refused, not a second cancel"` and `"the sweep skips a booking that stopped being pending and carries on"`.
5. **A developer's `:shopId` that names no shop.** `requireShopAccess` lets developers through without a shop check, so the raw param must never reach `shop_id` or `entity_id`. Test: Task 1 `"resolveShopParam returns null for an unknown or malformed id, without a lookup for the malformed one"`.

---

## Shared patterns (every route task uses these; Task 1 builds the pieces)

All imports below come from `apps/workers/booking/src/audit/context.ts` unless noted.

**Pattern B (batch).** Build the statements, then:
```ts
const refused = await batchWithAudit(c, stmts, input);
if (refused) return refused;
```
A batch failure propagates the original error (Ruling 9).

**Pattern T (two-step).** Move the handler's body, from its first effectful line to its response, into:
```ts
try {
  return await auditFor(c).run(input, async (): Promise<Response> => { /* moved body */ }, statusOutcome(extra));
} catch (e) {
  if (e instanceof AuditWriteError) return auditRefused(c);
  throw e;
}
```
- Validation that changes nothing stays before `run`, so a 400, 403 or 404 writes no rows.
- Inside `run`, an existing 4xx Response becomes outcome `refused`, and a 5xx becomes `failed`.
- `extra(res)` adds `entityId`, `changes`, `details`, `shopId` or `entityType` when the body only learns them as it runs. Capture them in variables the closure sets.

**Guarded batch.** `cancelPendingBookingStmts(db, bookingId)` (Task 4) plus the entry in one batch. On a thrown batch, re-read the booking:
- if it is no longer `pending`, the race was lost: answer as the handler always did for a no-op;
- otherwise rethrow.

**No silent 2xx** (Plan 2). Once a route is declared, the gap guard reads a 2xx without an entry as a coverage bug. Every early 2xx in a declared handler either sits inside `run` or writes its own best-effort `refused` entry with a structured `reason`.

**Every entry:**
- `shopId` is a resolved DB id: from `shopExists`, a row read, or `auditShopId`. Never the raw param.
- `entityType` and `entityId` name the row changed.
- `changes` come from `fieldChanges(before, after).changes`. The recorder filters them through the allow-list.
- `details.fields` lists changed personal or free-text field names, never values.

**Route keys** are the full paths Hono reports for the booking app, for example `POST /booking/shops/:shopId/sales`. Each task's table gives them exactly; each is a `ROUTE_AUDIT` key.

**Every task's test file:**
- lives in `apps/workers/booking/test/` and is named `audit-<group>.test.ts`;
- uses `dispatch` from `test/request.ts`, `tokenFor` and the seeders from `test/helpers.ts`, and `entriesFor`, `gapRowsFor`, `expectNoPersonalData` and `withAuditOff` from `test/audit-helpers.ts` (Task 1);
- for each route, has at least one test asserting the entry (action, outcome, actor type, `shop_id`, entity, changes, details);
- has one `withAuditOff` test for the refusal: 503, the verbatim body, and the change not made;
- has one test that the request leaves no `audit.gap` row (`gapRowsFor(res.headers.get("X-Request-Id")!) === 0`).

**Every task ends by:**
- lowering the booking worker's `PENDING_CEILING` by the number of keys it flipped;
- running the task's test file, the booking suite, `npx tsc --noEmit` in the booking worker, and eslint on the changed files;
- committing.

---

### Task 1: Booking worker glue, registry, coverage test, gap guard, catalogue and labels

**Files:**
- Modify: `packages/audit/src/actions.ts`, `packages/audit/src/allowlist.ts`, `packages/audit/src/recorder.ts`
- Test: `apps/worker/test/audit-recorder.test.ts` (the recorder's `run()` tests live there because they need D1), `packages/audit/test/allowlist.test.ts`
- Modify: `apps/workers/booking/package.json` (`"@repo/audit": "*"`), `package-lock.json` (via `npm install` at the root; workspace link only, no new external package)
- Create: `apps/workers/booking/src/audit/{context.ts,request-id.ts,gap-guard.ts,registry.ts,diff.ts}`
- Modify: `apps/workers/booking/src/index.ts`
- Create: `apps/workers/booking/test/{audit-helpers.ts,audit-coverage.test.ts,audit-gap-guard.test.ts}`
- Modify: `apps/web/app/lib/audit.ts`, `apps/web/app/lib/audit.test.ts`

**Interfaces:**
- Produces, in `@repo/audit`:
  - `AuditRunResult` gains `shopId?: string | null` and `entityType?: string | null`;
  - the outcome row uses `extra.shopId ?? input.shopId ?? null` and `extra.entityType ?? input.entityType ?? null`;
  - the 9 actions of decision 11.
- Produces, in `apps/workers/booking/src/audit/context.ts`:
  - `WORKER_NAME = "pivot-parlor-booking"`, `AUDIT_REFUSED_MESSAGE`, `SYSTEM_ACTOR`;
  - `requestIp(c): string | null` (the `CF-Connecting-IP` header or null);
  - `actorFrom(c): AuditActor` (anonymous plus IP with no user; otherwise the JWT's `sub`, `role` and `shop_id`, mapped as in the API's `ROLE_TO_ACTOR`);
  - `auditFor(c, via = "api", actor?)`, `systemAudit(db, via, requestId = null)`;
  - `statusOutcome(extra?)`, `auditRefused(c)`, `batchWithAudit(c, stmts, input, opts?)`;
  - `auditShopId(c, param): Promise<string | null>`, `UNRESOLVED_SHOP`.

  Each has the same contract as its `apps/worker/src/audit/context.ts` namesake.
- Produces, in `diff.ts`: `fieldChanges(before, after)`, the same contract as the API's `diff.ts`.
- Produces, in `gap-guard.ts`:
  - `auditGapGuard(registry = ROUTE_AUDIT)`, with the API guard's rules;
  - `via` is `"webhook"` for paths under `/webhooks/` and `"api"` otherwise;
  - `resolveShopParam(db, param): Promise<string | null>`. It is null for a param failing `/^[A-Za-z0-9_-]{1,128}$/`, with no lookup. Otherwise it returns `SELECT id FROM shops WHERE id = ?` (booking params are ids, never slugs).
- Produces, in `registry.ts`:
  - `ROUTE_AUDIT`, `CRON_AUDIT`, `PENDING_CEILING = 17`;
  - every key below starts as `"pending"`;
  - `CRON_AUDIT = { "*/15 * * * *": "pending" }`.
- Produces, in `index.ts`: `root.use("*", requestId)`, then `root.use("*", auditGapGuard())`, both before the schema middleware, plus `export { root as app }`.

**The 16 route keys:**

| Route key | Task |
|---|---|
| `POST /booking/shops/:shopId/complete-setup` | 2 |
| `POST /booking/platform/alerts/:alertId/resolve` | 2 |
| `POST /booking/shops/:shopId/connect/onboard` | 2 |
| `POST /booking/shops/:shopId/open` | 3 |
| `POST /booking/shops/:shopId/close` | 3 |
| `POST /public/bookings` | 4 |
| `POST /public/bookings/:bookingId/abandon` | 4 |
| `POST /booking/shops/:shopId/bookings` | 5 |
| `POST /booking/shops/:shopId/walk-ins` | 5 |
| `POST /booking/shops/:shopId/check-in` | 5 |
| `POST /booking/shops/:shopId/bookings/:bookingId/checkout` | 5 |
| `POST /booking/shops/:shopId/bookings/:bookingId/cancel` | 5 |
| `POST /booking/shops/:shopId/sales` | 6 |
| `POST /booking/shops/:shopId/sales/:saleId/refund` | 6 |
| `POST /booking/shops/:shopId/sales/:saleId/void` | 6 |
| `POST /webhooks/stripe` | 7 |

**Allow-list additions:**
- `shop` gains `"setup_completed"`, `"operational_status"` and `"stripe_connect_onboarded"`.
- New entity types: `business_day: ["status"]`, `sale: ["status"]`, `platform_alert: ["resolved"]`.

**Labels and groups:**

| Action | Label |
|---|---|
| `shop.setup.complete` | Shop setup completed |
| `day.open` | Shop opened for the day |
| `day.close` | Shop closed for the day |
| `booking.check_in` | Customer checked in |
| `booking.checkout` | Appointment checked out |
| `pos.void` | Till sale voided |
| `payment.connect.onboard` | Payout account setup started |
| `payment.connect.sync` | Payout account confirmed |
| `platform.alert.resolve` | Platform alert resolved |

New `ACTION_GROUPS`, after `"payment."`:
- `{ value: "pos.", label: "Till" }`
- `{ value: "day.", label: "Opening and closing" }`
- `{ value: "platform.", label: "Platform alerts" }`

- [ ] **Step 1: Write the failing tests**
  - `audit-recorder.test.ts`: `"run() outcome carries the shop and entity type its result names"`.
    - Start with `shopId: null, entityType: null`.
    - `describe` returns `{ shopId: <a seeded shop id>, entityType: "booking", entityId: "b-1" }`.
    - Assert the started row's `shop_id` and `entity_type` are null, and the outcome row's are that shop id and `"booking"`.
  - `allowlist.test.ts`: `"keeps the Plan 3 fields"`. `filterChanges("sale", { status: [...], customer_name: [...] })` keeps only `status`; `platform_alert` keeps `resolved`.
  - `audit-coverage.test.ts`: the API worker's six checks (`apps/worker/test/audit-coverage.test.ts`), against `app.routes` of the booking app and `apps/workers/booking/wrangler.toml`. There are no queue consumers in the booking worker; assert the queue list is empty.
  - `audit-gap-guard.test.ts`. Build a fixture Hono app (`requestId` plus `auditGapGuard(registry)` plus a few handlers), as `fixtureApp` / `send` do in `apps/worker/test/audit-gap-guard.test.ts`, so these tests never depend on which real routes are still pending:
    - `"a 2xx on a pending route writes one audit.gap with the route pattern, never the path"`:
      - use registry `{ "POST /fx/items/:id": "pending" }` and a handler answering 200;
      - assert one `audit.gap` row for the request id, `via: "api"`, with `details.route = "/fx/items/:id"` and the concrete id absent from `details_json`.
    - `"a 4xx on a declared route writes nothing, a 5xx writes the declared action as failed"`.
    - `"an exempt route writes nothing"`.
    - `"a 404 writes nothing"`.
    - `"a route under /webhooks/ records via webhook"`.
    - `"every response carries a server-generated X-Request-Id, and an inbound one is ignored"`: this one runs on the **real** app (`GET /health` through `dispatch`), which also proves the middleware is mounted.
    - `"resolveShopParam returns null for an unknown or malformed id, without a lookup for the malformed one"`:
      - a seeded shop's id returns the id;
      - an unknown, well-shaped id returns null;
      - `"a b/c"` returns null, and a spied `DB.prepare` is not called.
  - `apps/web/app/lib/audit.test.ts`: `"labels every Plan 3 action"` (each of the 9 has a label other than its action string). Also `"groups till, opening and closing, and platform alerts"`.
- [ ] **Step 2: Run them; expect failures.** Expect a missing export or unknown action, and a missing `app` export.
- [ ] **Step 3: Implement the files above.**
  - Copy `apps/worker/test/audit-helpers.ts`'s `entriesFor`, `gapRowsFor`, `withAuditOff` and `expectNoPersonalData` into the booking `test/audit-helpers.ts`, unchanged.
  - Run `npm install` at the repo root so the lockfile links the workspace.
- [ ] **Step 4: Run the four test files, the full booking suite, `packages/audit` tests, the web audit test, and `npx tsc --noEmit` in the booking worker.** All pass.
  - The existing booking suite must stay green with the gap guard mounted. It writes floor rows only.
- [ ] **Step 5: Commit** (`feat(audit): booking worker audit glue, registry and coverage test`).

---

### Task 2: Shop setup, platform alerts, Connect onboarding and sync

**Files:**
- Modify: `apps/workers/booking/src/routes/{setup.ts,platform-alerts.ts,connect.ts}`, `src/audit/registry.ts`
- Test: `apps/workers/booking/test/audit-shop-setup.test.ts`

| Route key | Action | Pattern | Entity | Changes / details |
|---|---|---|---|---|
| `POST /booking/shops/:shopId/complete-setup` | `shop.setup.complete` | B: the existing UPDATE plus the entry | `shop` / shopId (resolved by `shopExists`) | `changes: { setup_completed: [before, 1] }`, with `before` read with the checklist. A repeat records succeeded with no changes (Ruling 1). |
| `POST /booking/platform/alerts/:alertId/resolve` | `platform.alert.resolve` | T (guarded). Keep the pre-check 404. Inside `run`, use `UPDATE ... SET resolved = 1, resolved_at = ? WHERE id = ? AND resolved = 0`; `meta.changes` 0 returns the existing 404 body (refused). | `platform_alert` / the read row's id | `shopId` is the alert row's `shop_id` (a DB value). `changes: { resolved: [0, 1] }` on success. |
| `POST /booking/shops/:shopId/connect/onboard` | `payment.connect.onboard` | T: `run` from the shop read to the response. The 403, 404 and 400 answers stay before it. | `shop` / shopId | `details: { account_created: boolean }` only. Never the account id, the link URL, the return/refresh URLs or the owner email. A Stripe failure throws, so the outcome is `failed`. |
| GET `.../connect/status` (sync write only) | `payment.connect.sync` | B: the `stripe_connect_onboarded = 1` UPDATE plus the entry, in one batch (decision 8) | `shop` / shopId | `changes: { stripe_connect_onboarded: [0, 1] }`. If the entry cannot be written (`AuditWriteError`), skip the UPDATE and answer from the persisted columns. |

- [ ] **Step 1: Write the failing tests.**
  - One entry test per row.
  - The withAuditOff refusal for complete-setup: 503, and `setup_completed` still 0.
  - `"a second resolve of the same alert records refused"`: two sequential resolves give one `succeeded`, one `refused`, and both bodies unchanged.
  - `"onboarding never records the Stripe account id or link URL"`:
    - `expectNoPersonalData(row, ["acct_new_1", "https://connect.stripe.com/setup/e/test", <return_url>, <owner email>])`;
    - the fake Stripe returns `acct_new_1` and that link (see `vitest.config.ts`).
  - `"the status poll that confirms onboarding records payment.connect.sync"`, and `"a status poll whose entry cannot be written changes nothing and still answers"`. In the second one, under withAuditOff the response is 200 with `onboarded` from the persisted columns, and the column is still 0.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** Flip the three POST keys and lower `PENDING_CEILING` to 14.
- [ ] **Step 4: Run the test file, the booking suite and tsc.** All pass.
- [ ] **Step 5: Commit.**

---

### Task 3: Day open and close

**Files:**
- Modify: `apps/workers/booking/src/routes/day.ts`, `src/audit/registry.ts`
- Test: `apps/workers/booking/test/audit-day.test.ts`

| Route key | Action | Pattern | Entity | Changes / details |
|---|---|---|---|---|
| `POST /booking/shops/:shopId/open` | `day.open` | T: `run` from the business-day INSERT to the response. Shop, setup and already-open checks stay before it. | `business_day` / `businessDayId` | `changes: { status: [null, "open"] }`, `details: { date, slots_generated }`. |
| `POST /booking/shops/:shopId/close` | `day.close` | T: `run` from the no-show UPDATE to the response. The no-open-day check stays before it. | `business_day` / the open day's id | `changes: { status: ["open", "closed"] }`. `details`: the counts the handler already computes for its summary (no-shows, holds captured, holds that failed to capture, completed, walk-ins), as integers only. |

- [ ] **Step 1: Write the failing tests.**
  - An entry test for open and for close.
  - `"opening twice records nothing for the refused second open"`: the existing 400 pre-check, so no row.
  - `"close counts a failed no-show capture without failing"`:
    - seed a no-show whose deposit PI id contains `fail`, so the fake capture 500s;
    - the close answers as today;
    - the outcome is `succeeded`, with the failed-capture count at 1.
  - The withAuditOff refusal on open: 503, and no `bw_business_days` row.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** Flip both keys and lower `PENDING_CEILING` to 12.
- [ ] **Step 4: Run.** All pass.
- [ ] **Step 5: Commit.**

---

### Task 4: Public bookings, abandon, and the deposit sweep cron

**Files:**
- Modify:
  - `apps/workers/booking/src/db/queries.ts` (add `cancelPendingBookingStmts`);
  - `src/db/ensure-schema.ts` (NOT NULL assertion);
  - `src/routes/public.ts`, `src/services/deposit-sweep.ts`, `src/index.ts` (`scheduled`), `src/audit/registry.ts`.
- Test: `apps/workers/booking/test/audit-public.test.ts`
- Modify: `apps/workers/booking/test/schema-assert.test.ts`

**Interfaces:**
- Produces:
  - `cancelPendingBookingStmts(db, bookingId): D1PreparedStatement[]` is two statements:
    1. `UPDATE bookings SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE NULL END WHERE id = ?`
    2. `UPDATE bw_transactions SET status = 'cancelled' WHERE booking_id = ? AND type = 'deposit' AND status = 'pending'`

    Task 7 does not use it; see that task.
  - `assertNotNullColumn(db, table: string, column: string): Promise<void>`:
    - it throws `[booking] <table>.<column> must be NOT NULL (the deposit cancel guard depends on it)` when `PRAGMA table_info(<table>)` reports `notnull = 0` or no such column;
    - `table` and `column` must match `/^[a-z_]+$/`, else it throws, because PRAGMA cannot bind;
    - `assertBookingSchema` calls `assertNotNullColumn(db, "bookings", "status")` after its existing checks.
  - `sweepExpiredDepositBookings(db, nowMs?, maxPerRun?)` keeps its signature and return (the count cancelled). It records through `systemAudit(db, "cron")`.

| Route key | Action | Pattern | Entity | Changes / details |
|---|---|---|---|---|
| `POST /public/bookings` | `booking.create` (anonymous actor plus IP) | T: `run` from `createBooking` to the response. Validation, 404s and the slot-conflict pre-check stay before it. | `booking` / `id` | `shopId: shop.id`. `changes: { status: [null, "pending"] }`. `details: { channel: "online", deposit_required: boolean }`. The 409 (unique slot) becomes refused and the 502 (session failed) failed. |
| `POST /public/bookings/:bookingId/abandon` | `booking.cancel` (anonymous plus IP) | Guarded batch: `cancelPendingBookingStmts` plus the entry. | `booking` / bookingId | `shopId` is the `bw_booking_state` row's `shop_id`. `changes: { status: ["pending", "cancelled"] }`, `details: { reason: "abandoned" }`. On a lost race, write a best-effort `refused` entry, `reason: "not_pending"`, and return the unchanged `{ success: true }`. |
| cron `*/15 * * * *` | `booking.cancel` (system, `via: "cron"`) | Guarded batch per booking: the statements plus the entry. | `booking` / id | `shopId` from the stale-row query (add `b.shop_id` to its SELECT). `changes: { status: ["pending", "cancelled"] }`, `details: { reason: "deposit_expired" }`. On a lost race, skip the booking and continue (no entry: nothing changed). Any other error rethrows, as today. |

- Change the Checkout product name to `Booking deposit: ${service.name} at ${shop.name}` (decision 12).

- [ ] **Step 1: Write the failing tests.**
  - `"a free public booking records booking.create as anonymous"`:
    - `actor_type` is `anonymous`;
    - `ip_ref` is set;
    - `expectNoPersonalData(row, [name, email, phone, notes, shop name])`.
  - `"a deposit booking records deposit_required and never the Checkout URL"`: `expectNoPersonalData(row, ["cs_idem_deposit:<id>", "https://checkout.stripe.com/c/pay/cs_idem_deposit:<id>"])`.
  - `"a deposit booking whose session fails records failed"` (Review Focus 2):
    - make the fake Stripe fail session creation. Add a `fail` trigger to `/v1/checkout/sessions` in `vitest.config.ts`, keyed on the metadata, matching the existing `fail` conventions;
    - assert the 502;
    - assert the booking is `cancelled`;
    - assert exactly one outcome row, `failed`, reason `HTTP 502`.
  - `"the deposit Checkout product name carries no dash"`: capture the form body the fake Stripe receives.
  - `"abandon records booking.cancel"`, and `"abandon after the sweep cancelled records refused, not a second cancel"` (Review Focus 4).
  - `"the sweep records a cancel per expired booking as system via cron"`.
  - `"the sweep skips a booking that stopped being pending and carries on"`:
    - two stale bookings; flip the first to `confirmed` by a Proxy on `DB.batch` that commits the flip just before the first booking's batch (the `withConcurrentWrite` technique from `apps/worker/test/inventory-races.test.ts`);
    - the second is still cancelled;
    - the return is 1;
    - the first's status is `confirmed`.
  - `schema-assert.test.ts`: `"assertNotNullColumn throws when the column allows NULL"`. Create `t_nn_bad (status TEXT)` and `t_nn_ok (status TEXT NOT NULL)` in the test DB; the first throws and the second passes. Also add `"the real bookings.status passes"` and `"a malformed table name throws before any query"`.
  - The withAuditOff refusal on the public booking: 503, and no `bookings` row for that email.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** Flip both route keys and the cron key, and lower `PENDING_CEILING` to 9.
- [ ] **Step 4: Run.** All pass, including the existing `deposits.test.ts`, `deposit-cancel.test.ts` and `public-booking.test.ts`, unchanged.
- [ ] **Step 5: Commit.**

---

### Task 5: Staff bookings, walk-ins, check-in, appointment checkout, cancel

**Files:**
- Modify: `apps/workers/booking/src/routes/bookings.ts`, `src/audit/registry.ts`
- Test: `apps/workers/booking/test/audit-bookings.test.ts`

| Route key | Action | Pattern | Entity | Changes / details |
|---|---|---|---|---|
| `POST /booking/shops/:shopId/bookings` | `booking.create` | T: `run` from the first slot-claim UPDATE to the response | `booking` / the new id | `changes: { status: [null, <created status>] }`, `details: { channel: "staff", deposit_required: boolean }` |
| `POST /booking/shops/:shopId/walk-ins` | `booking.create` | T: `run` from the slot claim to the response | `booking` / the new id | `changes: { status: [null, <created status>] }`, `details: { channel: "walk_in" }` |
| `POST /booking/shops/:shopId/check-in` | `booking.check_in` | B: the existing upsert plus the entry | `booking` / the checked-in booking | `details: { already_checked_in: boolean }` from the row read before the upsert |
| `POST /booking/shops/:shopId/bookings/:bookingId/checkout` | `booking.checkout` | T: `run` from the conditional `confirmed → completed` claim to the response | `booking` / bookingId | `changes: { status: ["confirmed", "completed"] }` on success. `details: { sale_id, deposit_captured: boolean }`; `sale_id` is our UUID. A lost claim returns its existing 4xx (refused). |
| `POST /booking/shops/:shopId/bookings/:bookingId/cancel` | `booking.cancel` | T: `run` from the conditional flip to the response | `booking` / bookingId | `changes: { status: [before, "cancelled"] }` only when the flip changed a row. `details: { deposit: "refunded" \| "voided" \| "kept" \| "none" }` from the handler's own disposition. |

- [ ] **Step 1: Write the failing tests.**
  - One entry test per row.
  - `expectNoPersonalData` on the staff booking (customer name, email, phone, notes) and the walk-in (its customer name).
  - `"a checkout whose balance capture fails records failed and reverts the booking"`:
    - use a PI id containing `fail`;
    - the booking is back to `confirmed`;
    - the outcome is `failed`.
  - `"cancelling an already-cancelled booking records no second status change"`.
  - The withAuditOff refusal on the staff booking create: 503, no booking row, and the slot still free.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** Flip the five keys and lower `PENDING_CEILING` to 4.
- [ ] **Step 4: Run.** All pass, including `bookings.integrity.test.ts`, `deposit-cancel.test.ts` and `payment-integrity.test.ts`, unchanged.
- [ ] **Step 5: Commit.**

---

### Task 6: Till sales, refunds, voids

**Files:**
- Modify: `apps/workers/booking/src/routes/sales.ts`, `src/audit/registry.ts`
- Test: `apps/workers/booking/test/audit-sales.test.ts`

| Route key | Action | Pattern | Entity | Changes / details |
|---|---|---|---|---|
| `POST /booking/shops/:shopId/sales` | `pos.sale` | T: `run` from `claimSaleStock` to the response | `sale` / the new sale id | `changes: { status: [null, <status>] }`. `details: { tender, lines, total_pence }`: integers and the tender enum. A stock-claim loss returns its existing 409 (refused); a Stripe failure returns 502 (failed). |
| `POST /booking/shops/:shopId/sales/:saleId/refund` | `payment.refund.issue` | T: `run` from the return-claim batch to the response | `sale` / saleId | `details: { lines, refund_pence, via_stripe: boolean }`. The 409 is refused and the 502 failed. |
| `POST /booking/shops/:shopId/sales/:saleId/void` | `pos.void` | T: `run` from the guarded status flip to the response | `sale` / saleId | `changes: { status: [before, "voided"] }` on success |

- Copy fixes (decision 12):
  - `Invalid quantity: ${n} returnable on that line`
  - `Another refund touched this sale. Reload and try again.`

  Grep `apps/web` and `tests/e2e` for the old strings first; nothing may match on them.

- [ ] **Step 1: Write the failing tests.**
  - One entry test per row, including a Stripe-tender sale and a cash sale.
  - `expectNoPersonalData` on a sale carrying any customer fields the route accepts.
  - `"a second full refund records nothing"`: two sequential refunds of the whole quantity. The second answers its existing 400 ("Nothing left to refund on this sale") before `run`, so it leaves no row.
  - `"a refund that loses the claim race records refused"`:
    - use a Proxy on `DB.batch` that, just before the route's first batch (the return claim), commits a competing claim that sets the line's `returned_quantity` to its full `quantity`. This is the `withConcurrentWrite` technique from `apps/worker/test/inventory-races.test.ts`;
    - the route answers its existing 409;
    - the outcome row is `refused` with reason `HTTP 409`.
  - `"a refund whose Stripe call fails records failed and returns the stock claim"`.
  - The withAuditOff refusal on a cash sale: 503, no sale row, and stock unchanged.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** Flip the three keys and lower `PENDING_CEILING` to 1.
- [ ] **Step 4: Run.** All pass, including `sales-pos.test.ts`, `returns.test.ts` and `consumption.test.ts`, unchanged.
- [ ] **Step 5: Commit.**

---

### Task 7: Stripe webhook

**Files:**
- Modify: `apps/workers/booking/src/routes/stripe-webhook.ts`, `src/audit/registry.ts`
- Test: `apps/workers/booking/test/audit-webhook.test.ts`

**Shape (decision 6):**
- **After signature verification and payload parsing**, open `auditFor(c, "webhook", SYSTEM_ACTOR).run(...)` with:
  - `action: "payment.stripe.webhook"`;
  - `details: { event_id: stripeToken(event.id), event_type: stripeToken(event.type) }`.

  Copy `stripeToken` from `apps/worker/src/routes/webhooks.ts`.
- Inside `run`, in this order:
  1. the existing `processed_stripe_events` INSERT;
  2. a duplicate returns the existing `{ received: true, duplicate: true }` and sets `details.duplicate = true`;
  3. otherwise the existing switch runs, then the response.
- The existing catch, which deletes the dedupe row and returns 500, stays inside `run`. The outcome becomes `failed` with `HTTP 500`.
- An `AuditWriteError` from the started write returns `auditRefused(c)` (503) **before** the dedupe insert, so Stripe's retry is processed normally.
- **Per event**, each case sets closure variables that `extra` returns:
  - `shopId`: a DB-resolved shop id, read from the booking or sale row the case touches, or from `shops` by Connect account for `account.updated`;
  - `entityType` and `entityId`;
  - `details.handled`.

| Event | Entity | Changes |
|---|---|---|
| `account.updated` | `shop` | `{ stripe_connect_onboarded: [before, after] }` when it changed |
| `payment_intent.succeeded` (deposit) | `booking` | `{ status: ["pending", "confirmed"] }` when the conditional UPDATE changed a row |
| `payment_intent.succeeded` (sale) | `sale` | `{ status: [before, "completed"] }` |
| `charge.refunded` | `sale` or `booking` | details only |
| `checkout.session.expired` | `booking` | `{ status: ["pending", "cancelled"] }` when `results[0].meta.changes === 1` (keep its existing batch, not the guarded one: the webhook entry is not in that batch) |
| `charge.dispute.created` and unhandled types | none | `details.handled: false` |

- [ ] **Step 1: Write the failing tests.** Reuse the signing helper style of `test/stripe-webhook.test.ts`.
  - One entry test per handled event type: `via: "webhook"`, `actor_type: "system"`, the resolved `shop_id`, entity and changes.
  - `"a redelivered event records a duplicate, not a second change"` (Review Focus 1).
  - `"a handler failure records failed and keeps the event retryable"`: the dedupe row is gone and the response is 500.
  - `"an event whose started entry cannot be written answers 503 and is not deduped"`:
    - under withAuditOff, the response is 503;
    - `processed_stripe_events` has no row for the event id;
    - the booking is unchanged.
  - `"no Stripe object id or URL reaches the trail"`: `expectNoPersonalData` over the rows, against the PI, session, charge and account ids used in the fixtures.
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** Flip the key and lower `PENDING_CEILING` to 0.
- [ ] **Step 4: Run.** All pass, including `stripe-webhook.test.ts`, `deposits.test.ts` and `returns.test.ts`, unchanged.
- [ ] **Step 5: Commit.**

---

### Task 8: API proxies exempt, dash guard, docs

**Files:**
- Modify: `apps/worker/src/audit/registry.ts`
- Modify: `apps/worker/test/audit-gap-guard.test.ts` (its "real app" test relies on `POST /api/bookings` being pending)
- Create: `apps/workers/booking/test/no-dashes-in-errors.test.ts` (copy of `apps/worker/test/no-dashes-in-errors.test.ts` over `../src/routes/**/*.ts`)
- Modify: `CLAUDE.md`, adding one line under "AI / Background Workers": `booking` records its own audit entries (registry and coverage test in `apps/workers/booking/src/audit/`), and the API's booking proxies are exempt

**Registry change:**
- The 7 keys `POST /api/bookings`, `POST /api/bookings/:bookingId/abandon` and the five `ALL` connect/sales proxies become `{ exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" }`.
- The API's `PENDING_CEILING` becomes `0`, and the "Plan 3" comment block is reworded to say so.

- [ ] **Step 1: Write the failing tests.**
  - Replace the real-app gap test with `"an exempt booking proxy on the real app writes no floor row"`: `POST /api/bookings` against the BOOKING echo stub answers 201, and `gapRowsFor(rid)` is 0.
    - Pending-route floor rows stay covered by the existing fixture-app tests, which use their own registry.
  - The booking dash guard test, red until Task 6's copy fixes are in. If Task 6 is done, it is green at once: confirm it reads more than 5 route files and flags a planted sample, as the API's does.
- [ ] **Step 2: Run; expect the real-app test to fail** (the floor row is still written while the key is pending).
- [ ] **Step 3: Implement the registry change.**
- [ ] **Step 4: Run the root gate.**
  - `npm run check-types`, `npx turbo run test --force` (0 cached) and `npm run lint` all exit 0.
  - eslint is clean on every changed test file.
  - Both workers' coverage tests report pending 0.
- [ ] **Step 5: Commit.**

---

## After the last task

- **PR body.** Include:
  - the decisions above and the rulings made during execution;
  - the follow-ups:
    - Plan 4 (the AI workers);
    - the sale-line name dash;
    - the API's deposit-cancel entry staying details-only (decision 10);
    - the booking worker's public `workers.dev` surface (needed for the Stripe webhook).
  - the test plan;
  - a deploy note: merging deploys **booking first, then the API**, through CI. There is never a moment where a proxied change is recorded by neither worker:
    - before merge, the API writes floor rows;
    - after merge, booking records and the API exempts.
- **Post-merge read-only check.** The next real public booking or till sale in staging shows a `booking.create` / `pos.sale` row in `/dev/activity` with worker `pivot-parlor-booking`, and no "Unlabelled change" row for it.
