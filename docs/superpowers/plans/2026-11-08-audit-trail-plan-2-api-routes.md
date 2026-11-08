# Audit Trail, Plan 2 of 3: API Worker Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every state-changing route, cron and queue consumer that the API worker itself runs writes its own audit entry under the spec's refuse-on-failure rule. Only the 7 routes that forward to the booking worker stay `pending`, for Plan 3.

**Architecture:** Plan 1's helpers stay unchanged in shape: `batchWithAudit` for one-batch DB changes, and `auditFor(c).run` for two-step and guarded actions. They gain an explicit-actor option, and three small shared pieces arrive: `statusOutcome`, `fieldChanges` and the `*Stmt` statement builders. Each route then supplies only its action, entity and allow-listed changes. The gap guard learns to read the registry, so an `audit.gap` row means exactly one thing: a change that succeeded with no entry, which is a coverage bug.

**Tech Stack:** Cloudflare Workers (Hono 4.13.16), D1, KV, R2, `@cloudflare/vitest-pool-workers`, TypeScript, Remix (Activity labels only).

**Spec:** `docs/superpowers/specs/2026-09-26-audit-trail-design.md`, especially 3.3, 4.3-4.6, 8 and 11. **Predecessor:** `docs/superpowers/plans/2026-09-26-audit-trail-foundation.md` (Plan 1; its Rulings are cited by number below and live in that plan's review history and in the code comments that carry them).

## Global Constraints

- Refusal response for an audit write failure, verbatim: HTTP 503, `{ "success": false, "error": "Could not record this action; nothing was changed." }` (spec 4.4; `auditRefused(c)` already returns it).
- **Never store, in any audit column:**
  - passwords, password hashes, tokens (session, invite, verification, JWT), session ids, API keys, card data, Stripe event bodies, or full request bodies (spec 3.1);
  - personal data: names, email addresses, phone numbers, postal addresses, or any free text (notes, bio, review body, enquiry message, design notes). Shop name and slug count as personal data (Ruling 17).
- When a personal or free-text field changes, record its **name** in `details.fields`, never its value.
- `reason` and `details` are hashed and locked for 6 years. Put only structured values there (ids, counts, enums, model ids, `HTTP <status>`), never a thrown error's message.
- Money is INTEGER pence (CLAUDE.md). All SQL uses prepared statements with `.bind()`.
- Worker JSON keeps its existing response shapes. Instrumenting a route must not change any status code or body except the new 503 refusal.
- No migration in this plan. The next migration number stays `051`.
- Do not use em-dashes in user-facing text. The Activity labels (Task 10) are user-facing.
- Commits:
  - never `--no-verify`;
  - run `aramid check --staged` before each commit;
  - never stage `.aramid/`, `.githooks/`, `.graphite/` or `.impeccable/`;
  - end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not push, deploy, or touch staging or production data without the owner's go-ahead in the moment. Merging deploys the API worker and Pages through CI; the owner merges.
- `sed -i` rewrites CRLF files as LF in this repo. Edit with the editor tool.
- Worker tests: `cd apps/worker && npm test` (each file gets a fresh simulated D1/KV/R2). Console output inside tests is swallowed, so put diagnostics in assertion messages. Package tests: `cd packages/audit && npm test`.

## Decisions made while planning (owner can veto)

1. **The plan ends at `PENDING_CEILING = 7`, not 0** (a deviation from Plan 1 line 18, which predates the registry's proxy section).
   - `POST /api/bookings` and `POST /api/bookings/:bookingId/abandon` are pure BOOKING forwards, the same as the five `ALL` proxies the registry already gives to Plan 3. Only the booking worker can put the change and its entry in one batch.
   - They stay `pending` (the gap guard keeps a floor row) until Plan 3 instruments the booking worker and marks the hop exempt.
2. **The gap guard reads the registry** (Task 1). For a route declared with a catalogue action:
   - a 4xx response with no entry writes nothing, because nothing changed and refusals are stage 3;
   - a 5xx writes the declared action with `outcome: "failed"`;
   - a 2xx/3xx with no entry still writes `audit.gap`, since that is a coverage bug.

   Exempt routes write nothing. Pending and undeclared routes behave as they do today.
3. **Conditional ("guarded") writes use `run()`, not a batch.** A conditional write is a `... WHERE status = 'x'` UPDATE whose effect is known only from `meta.changes`. A batched entry would commit as `succeeded` even when the UPDATE matched nothing.
   - This follows the site-candidate precedent (`shops.ts`, `candidateOutcome`).
   - Stock-take complete keeps its claim-first shape (a claim, then the movements batch). Merging the two into one batch would lose the double-complete guard. The started/outcome pair makes a crash between them visible as `unknown`.
4. **Login, logout and invalid-credential refusals are recorded now** (`auth.login`, `auth.logout`). This pulls forward only the recording that spec 1.1 placed in stage 3. Still stage 3: OAuth sign-in (GET callbacks, which the coverage test does not see), role changes, denials and alerting.
   - **If vetoed:** `POST /auth/login` and `POST /auth/logout` stay `pending`, and the plan ends at 9.
5. **Reminder emails are recorded in the same batch as `markReminderSent`, after the send** (not started-first).
   - This keeps the cron's budget at 2 subrequests per booking (one Resend call plus one D1 batch, unchanged) at `REMINDER_MAX_PER_RUN = 500`.
   - A crash between send and batch leaves the reminder unmarked. It is sent again next run, and that send is recorded.
6. **Side-effect notification emails get no entry of their own**: the review request on completion, and booking confirmations. They are not the requested action.
   - Waitlist "slot open" emails do get entries, because each one changes a waitlist row (`status = 'notified'`).
7. **Naming:**
   - Stock, suppliers, purchase orders and stock takes live under `inventory.*`, so the Activity filter's single-prefix match groups them.
   - `product.*` covers products, variants and categories, distinguished by `entity_type`.
8. **The 20:00 EOD email is recorded** (`booking.eod_summary`) although it changes no data: it sends business data out of the platform.
9. **PO edit and PO receive keep their existing pre-check-then-batch semantics.** The entry joins their existing batch. Their pre-existing concurrency behaviour is unchanged by this plan, and is noted, not fixed.
10. **The `shop` allow-list drops `name`, `slug` and `phone`** (Ruling 17; nothing passes `shop` changes today) and gains the platform-economics fields.

## Review Focus

1. **A double-submitted guarded transition** (cancel the same PO twice; a customer cancels the same booking twice): exactly one `succeeded` outcome, and every response body is unchanged.
   - A second request that reaches the conditional write records `refused`.
   - One that an existing pre-check stops records nothing.
   - Tests: Task 5 `"a second PO cancel records refused"`, Task 6 `"a racing second self-cancel never records a second success"`.
2. **A refusal by router-level middleware** (a customer calling `PUT /api/shops/:id/bookings/:id/status`, refused by `bookings.use("*", ..., requireShopRole)`): no `audit.gap` row, because the guard must find the handler's declaration through `routePath(c, -1)`. Test: Task 1 `"a 403 from router middleware on a declared route writes no gap"`.
3. **Personal data leaking into a hashed column** through a create whose inputs are all personal (staff create, enquiry, review, walk-in join, waitlist join, register): none of the submitted name, email, phone, password or free-text values appear anywhere in the entry row. Tests: `expectNoPersonalData` in Tasks 3, 6, 7 and 8.
4. **A multi-statement create where the entry cannot be written** (staff create = user + staff + staff_services): nothing is left behind, including no orphan `platform_users` row for the email. Test: Task 3 `"staff create leaves no user row when the entry cannot be written"`.
5. **The reminder budget** (queue and cron): when the entry cannot be written, the reminder is not marked sent (so it retries), and one booking costs one `DB.batch` call after the send. Test: Task 9 `"reminder mark and entry share one batch"`.

---

## Shared patterns (every route task uses these; Task 1 builds the pieces)

**Pattern B (batch).** Use it for an unconditional D1 change.
- Build the statements with `*Stmt` builders, then call `const refused = await batchWithAudit(c, stmts, input); if (refused) return refused;`.
- A batch failure propagates the original error (Ruling 9). Existing `try/catch` blocks that map `UNIQUE` errors to 409 keep working if the batch call sits inside them.
- **Builder convention:** `<verb>Stmt(db, ...): D1PreparedStatement` lives in `apps/worker/src/db/queries.ts`. The existing executing helper becomes `return <verb>Stmt(...).run()`, so other callers are unchanged.
- An update builder whose field set is empty returns `null`, and callers drop nulls. Precedent: `createUserStmt`, `markInviteUsedStmt`, `activateShopStmt`.

**Pattern G (guarded) and Pattern T (two-step).** G covers a conditional write. T covers any effect that is not D1: R2, KV, email, `BOOKING.fetch`, AI, Stripe.
- Move the handler's body, from the first effectful line to its response, into the call below:
  ```ts
  try {
    return await auditFor(c).run(input, async (): Promise<Response> => { /* moved body */ }, statusOutcome(extra));
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
  ```
- Validation that changes nothing stays before `run`, so a 400 or 404 writes no rows.
- Inside `run`, a lost race returns its existing 4xx Response, which becomes outcome `refused`.

**No silent 2xx.** Once a route is declared, the gap guard reads any 2xx without an entry as a coverage bug. So every early 2xx return in a declared handler must do one of two things:
- write its own entry: a no-op answer writes a best-effort `refused` entry with a structured `reason`;
- or sit inside `run`.

Known cases: `POST /api/waitlist/:id/notify` answering `already_notified` (Task 6), and `PATCH /api/shops/:shopId` with no applicable field (Task 7).

**In the route tables,** `...` stands for `/api/shops/:shopId`. Each row's route string is its exact `ROUTE_AUDIT` key.

**Every entry:**
- `shopId` is the resolved shop id, never the raw URL param.
- `entityType` and `entityId` name the row changed.
- `changes` come from `fieldChanges(before, after).changes`; the recorder filters them through the allow-list.
- `details.fields` holds `fieldChanges(...).fields` whenever any field changed.

**Every task's test file:**
- uses `test/audit-helpers.ts` (Task 1);
- asserts the success entry: `action`, `outcome`, `phase`, `entity_type`, `entity_id` and parsed `changes_json`/`details_json`;
- asserts that the success request left no `audit.gap` row with its `request_id`;
- includes at least one `withAuditOff` test proving refusal: Pattern B returns ≥ 500 with the change absent, and G/T return 503 with the effect never run.

**Every route task ends by:**
- flipping its registry keys from `"pending"` to the listed action;
- lowering `PENDING_CEILING` by exactly the number flipped;
- running `cd apps/worker && npm test && npx tsc --noEmit`.

---

### Task 1: Foundations: catalogue, allow-lists, helpers, and a registry-aware gap guard

**Files:**
- Modify: `packages/audit/src/actions.ts`, `packages/audit/src/allowlist.ts`, `packages/audit/test/allowlist.test.ts`
- Create: `apps/worker/src/audit/diff.ts`, `apps/worker/test/audit-helpers.ts`, `apps/worker/test/audit-diff.test.ts`
- Modify: `apps/worker/src/audit/context.ts`, `apps/worker/src/audit/gap-guard.ts`, `apps/worker/src/audit/registry.ts`, `apps/worker/src/routes/shops.ts` (`candidateOutcome` → `statusOutcome`)
- Rewrite: `apps/worker/test/audit-gap-guard.test.ts` (fixture app; see Step 1)

**Interfaces:**
- Produces (context.ts):
  - `SYSTEM_ACTOR: AuditActor` (`{ type: "system" }`);
  - `actorForUser(user: { id: string; role: string; shop_id?: string | null }, ip: string | null): AuditActor`;
  - `auditFor(c, via?: Via, actor?: AuditActor): AuditRecorder`, where `actor` replaces `actorFrom(c)` and `onWrite` still sets `auditWritten`;
  - `batchWithAudit(c, changes, input, opts?: { via?: Via; actor?: AuditActor }): Promise<Response | null>`;
  - `statusOutcome(extra?: (res: Response) => Partial<AuditRunResult>): (res: Response) => AuditRunResult`: below 400 is `succeeded`, 4xx is `refused`, 5xx is `failed`; `reason` is `` `HTTP ${status}` `` when the status is 400 or above; `extra(res)` merges over the result.
- Produces (diff.ts): `fieldChanges(before: Record<string, unknown> | null, after: Record<string, unknown>): { changes: Record<string, [unknown, unknown]>; fields: string[] }`.
  - Keys of `after` whose value is `undefined` are ignored.
  - A key is changed when `(before?.[k] ?? null) !== (after[k] ?? null)`. The comparison is strict, on primitives.
  - `fields` is sorted.
- Produces (gap-guard.ts): `auditGapGuard(via: Via, registry: Record<string, AuditDeclaration> = ROUTE_AUDIT)`.
- Produces (test/audit-helpers.ts):
  - `entriesFor(filter: { action: string; shopId?: string; entityId?: string }): Promise<Record<string, unknown>[]>`, ordered by `occurred_at, rowid`;
  - `gapRowsFor(requestId: string): Promise<number>`;
  - `withAuditOff<T>(fn: () => Promise<T>): Promise<T>`, which renames `audit_log` to `audit_log_off` and restores it in `finally`;
  - `expectNoPersonalData(row: Record<string, unknown>, values: string[]): void`, which asserts that no value is a substring of `changes_json`, `details_json`, `reason` or `entity_id`;
  - `devToken()` and `adminToken(shopId)`, each returning `{ id, token }` via `seedUser` and `tokenFor`.
- Produces (actions): the 29 catalogue additions below. Later tasks use only these names, plus existing catalogue actions.

- [ ] **Step 1: Write the failing tests**

`packages/audit/test/allowlist.test.ts` adds two tests:
- `"shop changes never carry name, slug or phone"`. `filterChanges("shop", { name: ["a","b"], slug: ["x","y"], phone: ["1","2"], commission_rate: [0.1, 0.2] })` equals `{ commission_rate: [0.1, 0.2] }`.
- `"every new entity type keeps only structured fields"`. `filterChanges("staff", { display_name: ["A","B"], is_active: [1, 0] })` equals `{ is_active: [1, 0] }`, and `filterChanges("supplier", { email: ["a@x","b@x"] })` is `null`.

`apps/worker/test/audit-diff.test.ts` covers `fieldChanges`:
- `"returns only changed keys"`: `fieldChanges({ a: 1, b: 2 }, { a: 1, b: 3 })` equals `{ changes: { b: [2, 3] }, fields: ["b"] }`.
- `"treats a missing before as null"`: `fieldChanges(null, { a: 1 })` gives `changes` `{ a: [null, 1] }`.
- `"ignores undefined after-values"`: `fieldChanges({ a: 1 }, { a: undefined })` gives `fields` `[]`.

`apps/worker/test/audit-gap-guard.test.ts` is rewritten.
- Its existing cases dispatch to `/api/contact`, `/api/webhooks/stripe`, `/api/invites/:token/accept` and `DELETE /api/shops/:shopId/walkin`, all of which this plan instruments.
- Each case moves to a fixture `Hono` app built in the test:
  ```ts
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("*", requestId, auditGapGuard("api", registry));
  ```
  Each fixture route answers with a fixed status.
- Keep every existing assertion: route pattern recorded, never the raw path; the 429 skip; webhook `via`; Ruling 55 shop resolution through a `DELETE /fixture/shops/:shopId/thing` route; throw → `failed`; batch-commit failure → `failed`. Dispatch them with `app.request(...)` against `env`.
- Add these cases:
  - `"a 4xx on a declared route writes nothing"`: the registry is `{ "POST /fx/declared": "service.create" }`, the route returns 400, and the `audit_log` count is unchanged.
  - `"a 5xx on a declared route records the declared action as failed"`: the row has `action = 'service.create'`, `outcome = 'failed'`, `reason = 'HTTP 500'`, and its details match `{ route: "/fx/declared", status: 500 }`.
  - `"a 2xx on a declared route with no entry is still a gap"`: the row has `action = 'audit.gap'` and `outcome = 'succeeded'`.
  - `"an exempt route writes nothing"`: the registry is `{ "POST /fx/exempt": { exempt: "test fixture with a reason" } }`.
  - `"an ALL declaration covers mutating methods"`: the registry is `{ "ALL /fx/proxy": { exempt: "pure proxy in the fixture" } }`, and a POST writes nothing.
  - `"a 403 from router middleware on a declared route writes no gap"`. A sub-router has `.use("*", (c) => c.json({ success: false }, 403))` and `.put("/:id/status", handler)`, mounted at `/fx/items`. The registry is `{ "PUT /fx/items/:id/status": "booking.status" }`. No row is written.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/audit && npm test` and `cd apps/worker && npx vitest run test/audit-diff.test.ts test/audit-gap-guard.test.ts`.
Expected:
- The allowlist tests fail (`name` survives).
- `audit-diff` fails, because `../src/audit/diff` does not resolve.
- The gap-guard fails on `auditGapGuard`'s second argument (a type error under tsc, a gap row at runtime).

- [ ] **Step 3: Extend the catalogue and allow-lists**

Append these to `AUDIT_ACTIONS` in `packages/audit/src/actions.ts` (all pass `RE_ACTION = /^[a-z_.]{1,64}$/`):

```
"inventory.movement", "inventory.reorder",
"inventory.supplier.create", "inventory.supplier.update",
"inventory.po.create", "inventory.po.update", "inventory.po.order", "inventory.po.cancel", "inventory.po.receive",
"inventory.stock_take.open", "inventory.stock_take.count", "inventory.stock_take.complete", "inventory.stock_take.cancel",
"account.create", "account.update", "account.verify_email", "account.verification.send", "account.invite.accept",
"auth.login", "auth.logout",
"waitlist.join", "waitlist.update", "waitlist.notify",
"review.create", "enquiry.create", "staff.time_off.request",
"booking.reminder", "booking.eod_summary", "data.retention",
```

That is 29. Also reuse these existing actions: `walkin.serve`, `walkin.remove`, `booking.status`, `booking.cancel`, `site.edit`, `shop.create`, `shop.update` and `shop.settings.update`.

Change `CHANGE_ALLOWLIST` in `packages/audit/src/allowlist.ts`:
- **Replace `shop` with:** `["type", "plan", "status", "is_active", "commission_rate", "retail_commission_rate", "stripe_payment_status"]`. Add a comment citing Ruling 17: name, slug and phone are personal data.
- **Add these entries:**

| entity_type | allowed fields |
|---|---|
| `service` | `name`, `duration_min`, `price_pence`, `category`, `is_active` |
| `staff` | `is_active` |
| `schedule` | (none; details only) |
| `product` | `name`, `sku`, `category_id`, `supplier_id`, `cost_price_pence`, `retail_price_pence`, `tax_rate_bps`, `is_professional`, `track_stock`, `is_active` |
| `product_variant` | `name`, `sku`, `cost_price_pence`, `retail_price_pence`, `is_active` |
| `product_category` | `name`, `sort_order`, `is_active` |
| `supplier` | `is_active` |
| `stock_movement` | `product_id`, `variant_id`, `type`, `quantity_delta`, `unit_cost_pence` |
| `stock_level` | `reorder_point`, `reorder_qty` |
| `purchase_order` | `status`, `supplier_id` |
| `stock_take` | `status` |
| `booking` | `status` |
| `walkin_entry` | `status` |
| `waitlist_entry` | `status` |
| `review` | `rating` |
| `shop_setting` | `booking_enabled`, `booking_confirmation_email`, `booking_reminder_email`, `reminder_hours_before`, `review_request_email`, `deposits_enabled`, `deposit_percent`, `deposit_min_pence`, `show_instagram`, `show_facebook`, `show_tiktok`, `show_twitter`, `show_youtube`, `show_whatsapp`, `show_linkedin`, `show_google_business` |
| `platform_user` | `role`, `email_verified` |

- [ ] **Step 4: Write the helpers and the guard change**

`context.ts`:
- Add `SYSTEM_ACTOR`, `actorForUser`, the optional `actor` parameter on `auditFor`, the `opts` parameter on `batchWithAudit`, and `statusOutcome` (signatures above).
- `actorForUser` maps the role through the existing `ROLE_TO_ACTOR`.

`shops.ts`: replace `candidateOutcome(jobId)` with:
```ts
statusOutcome(() => ({ details: { job_id: jobId } }))
```
`site-candidate.test.ts` must still pass unchanged.

`gap-guard.ts`:
- Take the `registry` parameter.
- Resolve the declaration from the responding route first (`routePath(c)`), then the last matched route (`routePath(c, -1)`). For each candidate, try `` `${method} ${route}` `` and then `` `ALL ${route}` ``.
- Apply Decision 2:
  - exempt → return;
  - a catalogue action with a 4xx → return;
  - a catalogue action with a 5xx → write `{ action: decl, outcome: "failed", reason: `HTTP ${status}`, shopId, details }`, where `details` is as today;
  - otherwise → today's `audit.gap` write.
- The recorded `route` stays the responding pattern, as today. The import of `ROUTE_AUDIT` is safe, because `registry.ts` imports only types.

`registry.ts`:
- Move `"POST /api/bookings"` and `"POST /api/bookings/:bookingId/abandon"` out of the `// Plan 2` block, into the proxy block.
- Rename that comment to: `// Plan 3: forwarded to the booking worker; the booking worker records them, and the hop becomes exempt then.`
- `PENDING_CEILING` stays `71`.

- [ ] **Step 5: Run the tests**

Run: `cd packages/audit && npm test && npx tsc --noEmit`, then `cd apps/worker && npm test && npx tsc --noEmit`.
Expected:
- All pass, including `site-candidate.test.ts` and `audit-coverage.test.ts` (71 pending).
- If any other existing test counted `audit.gap` rows from a route that now 4xx-skips, report it rather than editing it.

- [ ] **Step 6: Commit**

```bash
git add packages/audit apps/worker/src/audit apps/worker/src/routes/shops.ts apps/worker/test/audit-helpers.ts apps/worker/test/audit-diff.test.ts apps/worker/test/audit-gap-guard.test.ts
aramid check --staged
git commit -m "feat(audit): Plan 2 catalogue and allow-lists, explicit actors, registry-aware gap guard"
```

---

### Task 2: Services and schedules

**Files:**
- Modify: `apps/worker/src/db/queries.ts`: add `createServiceStmt`, `updateServiceStmt` (returns `null` when empty), `setServiceProductsStmts(db, shopId, serviceId, entries): D1PreparedStatement[]` (it replaces the body of `setServiceProducts`), `upsertScheduleStmt` and `deactivateScheduleDayStmt`.
- Modify: `apps/worker/src/routes/services.ts`, `apps/worker/src/routes/schedule.ts`, `apps/worker/src/audit/registry.ts`
- Test: `apps/worker/test/audit-services.test.ts`

**Interfaces:** consumes Task 1's `batchWithAudit`, `fieldChanges`, `entriesFor`, `withAuditOff`, `adminToken` and `gapRowsFor`.

| Route | Pattern | Action | entity_type / id | changes / details |
|---|---|---|---|---|
| `POST /api/shops/:shopId/services` | B | `service.create` | `service` / new id | `fieldChanges(null, { name, duration_min, price_pence, category })` |
| `PUT /api/shops/:shopId/services/:serviceId` | B | `service.update` | `service` / id | `fieldChanges(svc, body)` |
| `PUT /api/shops/:shopId/services/:serviceId/products` | B | `service.update` | `service_products` / service id | details `{ product_count }` |
| `DELETE /api/shops/:shopId/services/:serviceId` | B | `service.delete` | `service` / id | `{ is_active: [svc.is_active, 0] }` |
| `PUT /api/shops/:shopId/schedule` | B | `schedule.update` | `schedule` / shop id | details `{ entries, staff_ids, days_off }` |

The schedule route today fires N separate writes through `Promise.all`. Read the existing `(staff_id, day_of_week) → id` rows first, then build every upsert or deactivate statement, then send one `batchWithAudit`.

- [ ] **Step 1: Write the failing tests** in `audit-services.test.ts`:
  - `"service create records the new service"`: POST with no category. Parsed `changes_json` equals `{ name: [null, "Skin fade"], duration_min: [null, 30], price_pence: [null, 2500] }`. A null category is unchanged from null, so it is absent.
  - `"service update records before and after for changed fields only"`: change `price_pence` from 2500 to 3000. `changes_json` equals `{ price_pence: [2500, 3000] }` and `details_json.fields` equals `["price_pence"]`.
  - `"service delete records is_active 1 to 0"`.
  - `"service products update records the product count"`.
  - `"schedule update is one batch with one entry"`: send 2 staff × 2 days. There is 1 `schedule.update` entry with `details.entries = 4`, and the schedule rows exist.
  - `"schedule update changes nothing when the entry cannot be written"`: wrapped in `withAuditOff`, the status is ≥ 500 and no `schedules` row exists for that staff.
  - `"a 400 on a real declared route writes no row"`: POST a service with no name. The response is 400, and `audit_log` has zero rows whose `request_id` is the response's `X-Request-Id` header. This proves that the real `routePath()` strings match the `ROUTE_AUDIT` keys; the Task 1 fixtures alone cannot.
  - Every success test also asserts `gapRowsFor(request_id) === 0`.
- [ ] **Step 2: Run to verify they fail.** `cd apps/worker && npx vitest run test/audit-services.test.ts`. Expected: FAIL, because no entries are written (only `audit.gap`).
- [ ] **Step 3: Implement.** Add the builders, convert the five handlers per the table, and flip the five registry keys. `PENDING_CEILING` goes from `71` to `66`.
- [ ] **Step 4: Run.** `cd apps/worker && npm test && npx tsc --noEmit`. Expected: all pass, including `services*.test.ts` and `schedule*.test.ts` unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat(audit): record service and schedule changes in their own batch"` (after `aramid check --staged`).

---

### Task 3: Staff, and staff's own requests

**Files:**
- Modify: `queries.ts`: add `createStaffMemberStmt`, `updateStaffMemberStmt` (`null` when empty) and `addStaffServiceStmt`; reuse the existing `createUserStmt`.
- Modify: `apps/worker/src/routes/staff.ts`, `apps/worker/src/routes/dashboard.ts` (`staffMeRouter` only), `registry.ts`
- Test: `apps/worker/test/audit-staff.test.ts`

| Route | Pattern | Action | entity_type / id | changes / details |
|---|---|---|---|---|
| `POST /api/shops/:shopId/staff` | B: `[createUserStmt, createStaffMemberStmt, ...addStaffServiceStmt]` | `staff.create` | `staff` / new staff id | `{ is_active: [null, 1] }`; details `{ user_id, services, temp_password_issued }` |
| `PUT /api/shops/:shopId/staff/:staffId` | B: `[updateStaffMemberStmt?, DELETE staff_services?, ...addStaffServiceStmt]` | `staff.update` | `staff` / id | details `{ fields, services? }` |
| `DELETE /api/shops/:shopId/staff/:staffId` | B | `staff.delete` | `staff` / id | `{ is_active: [member.is_active, 0] }` |
| `POST /api/shops/:shopId/staff/:staffId/avatar` | T (R2 put, then D1) | `staff.update` | `staff` / id | details `{ fields: ["avatar_url"] }` |
| `POST /api/staff/me/time-off` | B | `staff.time_off.request` | `staff_time_off` / new id | details `{ days }` (inclusive day count; no dates, no reason) |
| `PUT /api/staff/me/bookings/:bookingId/status` | B | `booking.status` | `booking` / id | `{ status: [existing.status, body.status] }` (widen the existing SELECT to read `status`) |

- [ ] **Step 1: Write the failing tests:**
  - `"staff create records ids only"`: assert the entry, then `expectNoPersonalData(row, [displayName, email, tempPasswordFromResponse])`.
  - `"staff create leaves no user row when the entry cannot be written"`: wrapped in `withAuditOff`, the status is ≥ 500 and `SELECT COUNT(*) FROM platform_users WHERE email = ?` is 0.
  - `"staff update lists changed field names, not values"`: `details.fields` equals `["bio", "display_name"]`, and `expectNoPersonalData` holds for the new bio.
  - `"staff delete records is_active 1 to 0"`.
  - `"avatar upload refuses before the R2 write when the started entry cannot be written"`: wrapped in `withAuditOff`, the status is 503 and `env.ASSETS.get(key)` is null.
  - `"time off records the day count, not the dates or reason"`.
  - `"staff booking status records before and after"`: the actor is `staff`.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run test/audit-staff.test.ts`. Expected: FAIL, no entries.
- [ ] **Step 3: Implement** per the table, and flip the six keys. `PENDING_CEILING` goes from `66` to `60`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`. Expected: all pass, including `staff*.test.ts`.
- [ ] **Step 5: Commit.** `"feat(audit): record staff changes, time off and staff booking status"`

---

### Task 4: Products, variants, categories and suppliers

**Files:**
- Modify: `queries.ts`: add `createProductCategoryStmt`, `updateProductCategoryStmt`, `createProductStmt`, `updateProductStmt`, `createProductVariantStmt`, `updateProductVariantStmt`, `createSupplierStmt` and `updateSupplierStmt`. The update builders return `null` when empty.
- Modify: `apps/worker/src/routes/products.ts`, `registry.ts`
- Test: `apps/worker/test/audit-products.test.ts`

| Route | Action | entity_type |
|---|---|---|
| `POST .../products/categories` | `product.create` | `product_category` |
| `PUT .../products/categories/:categoryId` | `product.update` | `product_category` |
| `POST .../products` | `product.create` | `product` |
| `PUT .../products/:productId` | `product.update` | `product` |
| `DELETE .../products/:productId` | `product.delete` | `product` (`{ is_active: [prev, 0] }`) |
| `POST .../products/:productId/variants` | `product.create` | `product_variant` (details `{ product_id }`) |
| `PUT .../products/:productId/variants/:variantId` | `product.update` | `product_variant` |
| `DELETE .../products/:productId/variants/:variantId` | `product.delete` | `product_variant` |
| `POST /api/shops/:shopId/suppliers` | `inventory.supplier.create` | `supplier` (details `{ fields }` only) |
| `PUT /api/shops/:shopId/suppliers/:supplierId` | `inventory.supplier.update` | `supplier` |

- All ten use Pattern B with `fieldChanges`, where `before` is the row read today, or `null` for creates.
- The `UNIQUE_RE` → 409 mapping must still work. Keep `batchWithAudit` inside the existing `try`.

- [ ] **Step 1: Write the failing tests:**
  - `"product price change records pence before and after"`: `retail_price_pence` goes from 1200 to 1500.
  - `"product description change records the field name only"`.
  - `"duplicate SKU still answers 409 and writes no entry and no gap"`.
  - `"variant create records its product"`.
  - `"category rename records name"`.
  - `"supplier create records no name, email or phone"`: uses `expectNoPersonalData`.
  - `"product create changes nothing when the entry cannot be written"`: wrapped in `withAuditOff`, no `products` row exists.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**, and flip the ten keys. `PENDING_CEILING` goes from `60` to `50`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`, including `products*.test.ts`.
- [ ] **Step 5: Commit.** `"feat(audit): record product, variant, category and supplier changes"`

---

### Task 5: Stock movements, reorder levels, purchase orders and stock takes

**Files:**
- Modify: `queries.ts`: add `setReorderLevelsStmt`; the existing `stockMovementStatements` is reused.
- Modify: `apps/worker/src/routes/inventory.ts`, `purchase-orders.ts`, `stock-takes.ts`, `registry.ts`
- Test: `apps/worker/test/audit-inventory.test.ts`

| Route | Pattern | Action | entity_type / id | changes / details |
|---|---|---|---|---|
| `POST .../inventory/movements` | B: `stockMovementStatements` | `inventory.movement` | `stock_movement` / new id | `fieldChanges(null, { product_id, variant_id, type, quantity_delta, unit_cost_pence })` |
| `PUT .../inventory/reorder` | B | `inventory.reorder` | `stock_level` / variant id when set, else product id | `{ reorder_point, reorder_qty }` before (current row or null) and after |
| `POST .../purchase-orders` | B: the existing batch + the entry | `inventory.po.create` | `purchase_order` / new id | `{ status: [null, "draft"] }`; details `{ items, supplier_id }` |
| `PUT .../purchase-orders/:poId` | B: the existing batch + the entry | `inventory.po.update` | `purchase_order` / id | details `{ items, fields }` |
| `POST .../purchase-orders/:poId/order` | G | `inventory.po.order` | `purchase_order` / id | on success `{ status: ["draft", "ordered"] }` |
| `POST .../purchase-orders/:poId/cancel` | G | `inventory.po.cancel` | `purchase_order` / id | on success `{ status: [prev, "cancelled"] }`; read `prev` before `run` for the changes only, and never reject on it (the conditional UPDATE stays the only gate) |
| `POST .../purchase-orders/:poId/receive` | B: the existing batch + the entry | `inventory.po.receive` | `purchase_order` / id | details `{ lines, units }` |
| `POST .../stock-takes` | B | `inventory.stock_take.open` | `stock_take` / new id | `{ status: [null, "open"] }` |
| `PUT .../stock-takes/:stockTakeId/items` | B: the existing batch + the entry | `inventory.stock_take.count` | `stock_take` / id | details `{ items }` |
| `POST .../stock-takes/:stockTakeId/complete` | G (claim, then the movements batch, inside `run`) | `inventory.stock_take.complete` | `stock_take` / id | outcome details `{ items_counted, items_adjusted }` |
| `POST .../stock-takes/:stockTakeId/cancel` | G | `inventory.stock_take.cancel` | `stock_take` / id | on success `{ status: ["open", "cancelled"] }` |

Note on stock takes: the `note` the complete route writes into each movement (`... by ${user.sub}`) is stock data, not audit data, and stays as it is.

- [ ] **Step 1: Write the failing tests:**
  - `"a manual movement records type and delta with the stock change"`.
  - `"reorder records before and after"`.
  - `"PO create records item count"`.
  - `"PO order records draft to ordered"`.
  - `"a second PO cancel records refused"`: the first cancel answers 200, the second 400 (body unchanged). The entries show exactly one `succeeded` outcome and one `refused` outcome, with `reason = "HTTP 400"`.
  - `"PO receive records lines and units with the stock movements"`.
  - `"stock take complete records counted and adjusted"`.
  - `"stock take complete refuses before claiming when the started entry cannot be written"`: wrapped in `withAuditOff`, the status is 503 and the stock take is still `open`.
  - `"movement changes nothing when the entry cannot be written"`: no `stock_movements` row, and the `stock_levels` quantity is unchanged.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**, and flip the eleven keys. `PENDING_CEILING` goes from `50` to `39`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`, including `inventory*`, `purchase*` and `stock-take*` tests.
- [ ] **Step 5: Commit.** `"feat(audit): record stock movements, purchasing and stock takes"`

---

### Task 6: Bookings, walk-ins, waitlist and the customer's own account

**Files:**
- Create: `apps/worker/src/services/waitlist-claim.ts`, exporting `notifyWaitlistEntry(db, apiKey, shop, entry, recorder: AuditRecorder, trigger: "manual" | "slot_opened"): Promise<"sent" | "lost">`.
  - It runs `recorder.run({ action: "waitlist.notify", shopId, entityType: "waitlist_entry", entityId, details: { trigger } }, ...)` around: claim; on a lost claim, return `"lost"`; send; on a send failure, `revertWaitlistNotification`, then rethrow.
  - The describe callback maps `"lost"` to `refused` and `"sent"` to `succeeded` with `{ status: ["waiting", "notified"] }`.
- Modify: `apps/worker/src/services/waitlist-notify.ts`: `notifyWaitlistForOpenedSlot` gains a required `recorder: AuditRecorder` parameter and uses `notifyWaitlistEntry(..., "slot_opened")` per entry. An `AuditWriteError` from it is caught and reported like a send failure; the cancellation itself stands.
- Modify: `apps/worker/src/routes/bookings.ts` (`PUT /:bookingId/status` only), `walkin.ts`, `waitlist.ts`, `dashboard.ts` (`meRouter` cancel and profile), `registry.ts`
- Test: `apps/worker/test/audit-bookings-queues.test.ts`

| Route | Pattern | Action | entity_type | changes / details |
|---|---|---|---|---|
| `PUT /api/shops/:shopId/bookings/:bookingId/status`, deposit fork | T around `BOOKING.fetch` | `booking.cancel` | `booking` | details `{ deposit: true, refund_deposit: boolean \| null }` |
| same, `status = cancelled`, local | G around `cancelBookingIfOpen` and its existing fallback `updateBookingStatus` | `booking.cancel` | `booking` | outcome details `{ flipped }`; changes `{ status: [prev, "cancelled"] }` only when flipped |
| same, any other status | B | `booking.status` | `booking` | `{ status: [booking.status, body.status] }` |
| `POST /api/me/bookings/:bookingId/cancel` | G around the atomic UPDATE | `booking.cancel` | `booking` | on success `{ status: [prev, "cancelled"] }` |
| `PATCH /api/me/profile` | B | `account.update` | `platform_user` / `user.sub` | details `{ fields }` |
| `POST /api/walkin/:shopSlug/join` | B, then the KV bust | `walkin.join` | `walkin_entry` / new id | `{ status: [null, "waiting"] }`; anonymous actor + IP |
| `PATCH /api/shops/:shopId/walkin/:entryId` | B: the status UPDATE + the entry; `reorderQueue` and the KV bust stay post-steps (positions are a derived order that every PATCH recomputes) | `walkin.serve` (status waiting, serving or served) or `walkin.remove` (skipped or removed) | `walkin_entry` | `{ status: [prev, next] }` (widen the existing SELECT to read `status`) |
| `DELETE /api/shops/:shopId/walkin` | G (the count is known only from `meta.changes`) | `walkin.remove` | `walkin_entry` / null | outcome details `{ cleared: meta.changes }` |
| `POST /api/waitlist` | B | `waitlist.join` | `waitlist_entry` / new id | `{ status: [null, "waiting"] }`; anonymous actor + IP |
| `PATCH /api/waitlist/:id/status` | B | `waitlist.update` | `waitlist_entry` | `{ status: [prev, next] }` |
| `POST /api/waitlist/:id/notify` | `notifyWaitlistEntry(..., "manual")`; the pre-run `already_notified` 200 writes a best-effort `waitlist.notify` entry, `refused`, with reason `"already_notified"` | `waitlist.notify` | `waitlist_entry` | as in the helper |

Both slot-freeing routes pass `auditFor(c)` as the recorder to `notifyWaitlistForOpenedSlot`, so each slot-open email records the person whose cancel freed the slot.

- [ ] **Step 1: Write the failing tests:**
  - `"local cancel records the flip once"`.
  - `"deposit cancel records the forward and its outcome"`: the BOOKING echo stub answers 201, giving a `started` row and an outcome row with `succeeded`.
  - `"status completed records booking.status before and after"`.
  - `"a racing second self-cancel never records a second success"`: send two cancels together with `Promise.all`. Exactly one response is 200, and exactly one `booking.cancel` outcome row is `succeeded`. Any other outcome row is `refused`, with `reason` `"HTTP 409"`. A request stopped by the "already closed" pre-check writes no row.
  - `"walk-in join records no name, phone or notes"`: uses `expectNoPersonalData`.
  - `"walk-in serve and remove pick the right action"`.
  - `"queue clear records the count"`.
  - `"waitlist join records no customer details"`.
  - `"manual notify refuses before claiming when the started entry cannot be written"`: wrapped in `withAuditOff`, the status is 503 and the entry is still `waiting`. Set `RESEND_API_KEY` in this test's env, or assert the existing 503 `"Email sending is not configured"` path instead, whichever the test env supports; read `vitest.config.mts` bindings first.
  - `"profile update lists field names only"`.
  - `"notifying an already-notified entry leaves no gap"`: seed the entry with `status: "notified"`. The response is 200 `already_notified`. There is one `refused` entry with reason `"already_notified"`, and `gapRowsFor(requestId)` is 0. The route checks this branch before the `RESEND_API_KEY` check, so the test needs no key.
  - `"a 403 from the bookings router middleware writes no gap"`: send a customer token to `PUT .../bookings/:id/status`. The response is 403, and no `audit.gap` row has the response's `X-Request-Id`. This is the real-app proof of the `routePath(c, -1)` lookup.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**, and flip the nine keys. `PENDING_CEILING` goes from `39` to `30`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`, including `booking-cancel-fork.test.ts`, `walkin*`, `waitlist*` and `me*` tests unchanged.
- [ ] **Step 5: Commit.** `"feat(audit): record booking status, walk-ins, waitlist and customer self-service"`

---

### Task 7: Shop create, update, settings, reviews and site images

**Files:**
- Modify: `queries.ts`: add `createShopStmt`, `createInviteStmt` and `upsertShopSubjectStmt(db, shop: { id; name; slug })`. The last one is extracted from `deleteShopDeveloper`, which then uses it.
- Modify: `apps/worker/src/routes/shops.ts`, `registry.ts`
- Test: `apps/worker/test/audit-shops.test.ts`

| Route | Pattern | Action | entity_type | changes / details |
|---|---|---|---|---|
| `POST /api/shops` | T (Stripe Checkout is external): inside `run`, one batch `[createShopStmt, createInviteStmt, upsertShopSubjectStmt]`, then Stripe and the later updates unchanged | `shop.create` | `shop` / new id | outcome details `{ shop_subject: "subj_shop_<id>", flow: "stripe" \| "invite", type, plan }` |
| `PATCH /api/shops/:shopId` | B, always called, even when no field applies (then `changes` is empty and details `{ fields: [] }`) | `shop.update` | `shop` | `fieldChanges(shopRow, appliedFields)`; name and phone reach only `details.fields` (Task 1 allow-list) |
| `PATCH /api/shops/:shopId/settings` | B: `[INSERT INTO shop_settings (shop_id) VALUES (?) ON CONFLICT(shop_id) DO NOTHING, UPDATE ...]` replaces today's update-then-insert-then-update | `shop.settings.update` | `shop_setting` / shop id | `fieldChanges(currentRow, coercedValues)` |
| `POST /api/shops/:shopId/settings` | T (KV put) | `shop.settings.update` | `generation_prefs` / shop id | details `{ text_model, image_model, composer, text_effort, design_notes_set }` |
| `POST /api/shops/:shopId/reviews` | B | `review.create` | `review` / new id | `{ rating: [null, rating] }`; details `{ booking_id }`; anonymous actor + IP |
| `POST /api/shops/:shopId/generate-image` | T `site.edit`, with an inner `auditFor(c).run({ action: "ai.call", ... details: { purpose: "image", model, visual } }, () => generateOpenRouterImageBuffer(...))` | `site.edit` | `shop_site` / shop id | details `{ op: "generate", visual, image_model }` |
| `POST /api/shops/:shopId/upload-image` | T (R2 put) | `site.edit` | `shop_site` | details `{ op: "upload", visual }` |
| `POST /api/shops/:shopId/save-image` | T (`persistVisualImage`) | `site.edit` | `shop_site` | details `{ op: "save", visual }` |
| `POST /api/shops/:shopId/remove-image` | T (`clearVisualImage`) | `site.edit` | `shop_site` | details `{ op: "remove", visual }` |

`visual` is `"logo"`, `"hero"` or `"service:<id>"` (the `typeLabel` already computed).

- Check that `shop_settings.shop_id` is unique (`grep -n "CREATE TABLE IF NOT EXISTS shop_settings" -A10 apps/worker/src/db/schema.sql`) before relying on `ON CONFLICT(shop_id)`.
- If it is not unique, keep the existing three-statement order inside the batch, with the INSERT guarded as `INSERT ... SELECT ? WHERE NOT EXISTS (SELECT 1 FROM shop_settings WHERE shop_id = ?)`.

- [ ] **Step 1: Write the failing tests:**
  - `"shop create records the subject ref, never the name or slug"`: in the legacy no-Stripe flow (the test env sets no `STRIPE_SECRET_KEY`; confirm in `vitest.config.mts`), `audit_subjects` has `subj_shop_<id>` with `display_name` `"<name> (<slug>)"`, and `expectNoPersonalData(row, [name, slug, ownerEmail, inviteToken])` holds.
  - `"shop update by a developer records commission before and after"`.
  - `"shop rename records the field name only"`.
  - `"settings patch records deposit policy before and after and drops the address"`.
  - `"settings patch on a shop with no settings row is one batch"`: wrapped in `withAuditOff`, no `shop_settings` row exists afterwards.
  - `"review create records rating and booking only"`.
  - `"generate-image refuses before calling the image model when the started entry cannot be written"`: wrapped in `withAuditOff`, the status is 503, and a `vi.spyOn(globalThis, "fetch")` proves no OpenRouter call was made.
  - `"save-image and remove-image record the visual"`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**, and flip the nine keys. `PENDING_CEILING` goes from `30` to `21`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`, including `shops*`, `generate-*`, `visual*` and `site-candidate*` tests.
- [ ] **Step 5: Commit.** `"feat(audit): record shop create/update/settings, reviews and site image edits"`

---

### Task 8: Accounts, sign-in, invites, enquiries and the Stripe webhook

**Files:**
- Modify: `apps/worker/src/routes/auth.ts`, `invites.ts`, `contact.ts`, `webhooks.ts`, `queries.ts` (`updateShopPaymentCompleteStmt`, `setInviteActiveStmt`), `registry.ts`
- Test: `apps/worker/test/audit-accounts.test.ts`

| Route | Pattern | Action | Actor | entity / changes / details |
|---|---|---|---|---|
| `POST /auth/login`, success | T (KV session put, plus the best-effort rehash) | `auth.login` | `actorForUser(user, ip)` | `platform_user` / user id |
| `POST /auth/login`, bad credentials | an explicit best-effort `write` before the 401 (a failed write is logged and the 401 stands, since nothing changed) | `auth.login` (`refused`, reason `"invalid_credentials"`) | anonymous + IP | `platform_user` / user id when the email matched, else null |
| `POST /auth/logout` | T (KV delete) | `auth.logout` | the session user | `platform_user` / `user.sub` |
| `POST /auth/register` | B `[createUserStmt]`, then T for the verification email. An `AuditWriteError` in the T step counts as `verification_email_sent: false`, and the recorded account stands. | `account.create`, then `account.verification.send` | anonymous + IP, or the developer caller (`actorForUser(caller, ip)`) | `platform_user` / new id; `{ role: [null, role], email_verified: [null, v] }` |
| `POST /auth/verify-email` | B `[UPDATE email_verified = 1]`, then the KV delete | `account.verify_email` | anonymous + IP | `platform_user` / id; `{ email_verified: [prev, 1] }` |
| `POST /auth/resend-verification` | T | `account.verification.send` | the session user | `platform_user` / id |
| `POST /api/invites/:token/accept` | B: the existing four-statement batch + the entry | `account.invite.accept` | `actorForUser({ id: userId, role: invite.role, shop_id: invite.shop_id }, ip)` | `invite` / invite id; details `{ user_id, role, document, version }` |
| `POST /api/contact` and `POST /contact` (one handler) | B | `enquiry.create` | anonymous + IP | `contact` / new id; details `{ shop_type }` |
| `POST /api/webhooks/stripe` | B with `{ via: "webhook", actor: SYSTEM_ACTOR }` | `payment.stripe.webhook` | system | below |

**Webhook:**
- `handleCheckoutSessionCompleted(db, session, recorder?: AuditRecorder)` builds `[updateShopPaymentCompleteStmt, setInviteActiveStmt]`.
- With a recorder, it commits them and the entry through `recorder.batch`: entity `shop` / shop id, changes from the shop row before and after for `status` and `stripe_payment_status`, details `{ event_id, event_type }`.
- Without a recorder, it uses `db.batch`, so its existing unit tests keep their signature.
- Missing metadata or an unknown shop: a `refused` entry with reason `"missing_metadata"` or `"shop_not_found"`.
- Any other verified event type: a `succeeded` entry with details `{ event_type, handled: false }`.
- Signature failures stay 400 with no entry (Decision 2).
- The route passes `auditFor(c, "webhook", SYSTEM_ACTOR)`.
- An `AuditWriteError` returns `auditRefused(c)` (503 JSON), so Stripe retries the event. A batch commit failure propagates (Ruling 9) and Stripe retries that too.

**The login refusal must not record the submitted email anywhere** (spec 3.1). Sessions, verification tokens and invite tokens appear in no entry.

- [ ] **Step 1: Write the failing tests:**
  - `"login records the user as actor, never the token"`: `actor_ref` is `subj_user_<id>`, and `expectNoPersonalData(row, [token, email, password])` holds.
  - `"a wrong password records a refused login for that account"`.
  - `"an unknown email records a refused login with no entity and no email"`.
  - `"logout records the session user"`.
  - `"public register records a customer account, no name or email"`.
  - `"register leaves no user when the entry cannot be written"`: uses `withAuditOff`.
  - `"verify-email records email_verified 0 to 1"`.
  - `"invite accept records the acceptance with document and version"`: also assert the account, legal acceptance and shop activation all exist, then repeat under `withAuditOff` and assert none of the four writes happened.
  - `"enquiry records no name, email or message"`.
  - `"checkout webhook records the payment as system via webhook"`: call `handleCheckoutSessionCompleted` with a recorder built by `createAuditRecorder({ db: env.DB, worker: "pivot-parlor-api", via: "webhook", actor: { type: "system" }, requestId: null })`, then assert the entry and the shop's `stripe_payment_status = 'paid'`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**, and flip the nine keys (`/auth/login`, `/auth/logout`, `/auth/register`, `/auth/verify-email`, `/auth/resend-verification`, invite accept, both contact paths, the webhook). `PENDING_CEILING` goes from `21` to `12`.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`, including `auth*`, `invite*`, `contact*`, `webhook*`, `oauth*` and `audit-site-routes.test.ts`.
- [ ] **Step 5: Commit.** `"feat(audit): record accounts, sign-in, invites, enquiries and the Stripe webhook"`

---

### Task 9: Crons and the reminder queue

**Files:**
- Create: `apps/worker/src/services/reminder-deliver.ts`, exporting `deliverReminder(db: D1Database, resendApiKey: string | undefined, booking: DueReminder, recorder: AuditRecorder): Promise<void>`.
  - It sends exactly as today. Then it commits `recorder.batch([markReminderSentStmt(db, booking.id)], { action: "booking.reminder", outcome, shopId: booking.shop_id, entityType: "booking", entityId: booking.id, details: { channel: "email" | "log_only", send: "ok" | "failed" } })`.
  - `outcome` is `failed` when the send threw, `succeeded` otherwise (Decision 5).
- Modify:
  - `apps/worker/src/services/reminder.ts`: `processReminder` and `sendPendingReminders` both call `deliverReminder`; both booking SELECTs add `b.shop_id`.
    - Each gains an optional last parameter, `recorder?: AuditRecorder`. It defaults to `systemAudit(db, "queue")` for `processReminder` and `systemAudit(db, "cron")` for `sendPendingReminders`.
    - The defaults keep `reminder.status.test.ts` and `reminder.cron-bounds.test.ts` (which call them with three and two arguments) unchanged.
  - `apps/worker/src/db/queries.ts`: add `markReminderSentStmt`; `getBookingsDueForReminder` adds `shop_id`.
  - `apps/worker/src/index.ts`: the `scheduled` and `queue` handlers.
  - `registry.ts`.
- Test: `apps/worker/test/audit-crons.test.ts`

| Trigger | Recorder | Action | Shape |
|---|---|---|---|
| `0 3 * * *` | `systemAudit(env.DB, "cron")` | `data.retention` | `run` around `runRetentionSweep`; describe gives `outcome` `failed` when `errors.length > 0`, details `{ counts, failed_tables: errors.map(e => e.table) }` (never the error strings). An `AuditWriteError` skips the sweep and is logged; the nightly check still runs in its own `try`. |
| `0 8 * * *` | `systemAudit(env.DB, "cron")` | `booking.reminder` | per booking via `deliverReminder` |
| `0 20 * * *` | `systemAudit(env.DB, "cron")` | `booking.eod_summary` | `run` around `sendEodAlert`, only when an email is actually attempted; details `{ date, booking_count, shop_count }` |
| queue `pivot-parlor-reminders` / `-staging` | `systemAudit(env.DB, "queue", msg.id)` | `booking.reminder` | `processReminder(body, env.DB, key, recorder)` → `deliverReminder`; not-due and already-sent messages write nothing |

`systemAudit` has no `onWrite`. That is correct here: crons and queues are outside the gap guard.

- [ ] **Step 1: Write the failing tests:**
  - `"retention run records counts per table"`: seed one stale `chat_sessions` row, call `index.default.scheduled({ cron: "0 3 * * *" } as ScheduledEvent, env, ctx)`. Expect one `data.retention` started row and one outcome row, with `details.counts.chat_sessions >= 1`.
  - `"retention is skipped when its entry cannot be written"`: wrapped in `withAuditOff`, the stale row still exists.
  - `"cron reminder records the booking and marks it sent"`.
  - `"reminder mark and entry share one batch"`: wrapped in `withAuditOff`, `reminder_sent` stays 0.
    - Separately, call `deliverReminder` directly with a counting `Proxy` around `env.DB`. Pass the same proxy to `createAuditRecorder`.
    - The proxy's `get` wraps `batch` to count calls, and binds every other function to the target.
    - Assert exactly one `batch` call for one delivered booking.
  - `"queue reminder records the message id as request id"`.
  - `"EOD summary records counts, never the developer email"`. If `RESEND_API_KEY` is unset in tests, assert instead that no entry is written (no email attempted).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Flip `"0 3 * * *"`, `"0 8 * * *"`, `"0 20 * * *"`, `"pivot-parlor-reminders"` and `"pivot-parlor-reminders-staging"` to their actions. `PENDING_CEILING` goes from `12` to `7`. The remaining seven are exactly the Plan 3 proxy block.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit`, including `reminder*`, `retention*`, `audit-retention*`, `parity*` and the `audit-nightly*` tests.
- [ ] **Step 5: Commit.** `"feat(audit): record retention runs, reminders and the EOD summary"`

---

### Task 10: Activity labels for every action

**Files:**
- Modify: `apps/web/app/lib/audit.ts` (`LABELS`, `ACTION_GROUPS`, and the comment above `LABELS`), `apps/web/app/lib/audit.test.ts`
- Create: `apps/worker/test/audit-labels.test.ts`

**Interfaces:** consumes `AUDIT_ACTIONS` from `@repo/audit`.

- [ ] **Step 1: Write the failing test** `apps/worker/test/audit-labels.test.ts`, named `"every catalogue action has an Activity label"`.
  - Import `../../web/app/lib/audit.ts?raw`, the way `audit-coverage.test.ts` imports `wrangler.toml?raw`.
  - For each `AUDIT_ACTIONS` member, assert the raw text contains `` `"${action}":` ``.
  - The test lives in the worker suite because `apps/web` does not depend on `@repo/audit`, and adding that dependency is out of scope.
- [ ] **Step 2: Run to verify it fails.** `cd apps/worker && npx vitest run test/audit-labels.test.ts`.
  - Expected: an assertion failure listing the Plan 2 actions, plus every older action without a label (`site.regenerate.complete`, `site.edit`, `shop.create`, ...).
  - A module-load error on the `?raw` import, which sits outside the worker root, is NOT the expected failure. Fix the import first; if Vite refuses the path, read the file with `node:fs` instead.
- [ ] **Step 3: Write the labels.**
  - Use sentence case, plain words, and no em-dashes. Use the existing labels as the tone reference: "Site paused", "Theme applied".
  - Examples: `service.create` "Service added", `inventory.po.receive` "Stock received", `auth.login` "Signed in", `booking.reminder` "Reminder sent", `data.retention` "Old records cleared".
  - Add these `ACTION_GROUPS` after "Shops": Services `service.`, Staff `staff.`, Schedules `schedule.`, Products `product.`, Inventory `inventory.`, Bookings `booking.`, Walk-ins `walkin.`, Waitlist `waitlist.`, Payments `payment.`, Accounts `account.`, Sign-ins `auth.`, Reviews `review.`, Enquiries `enquiry.`, Data `data.`.
  - Update the comment above `LABELS` so it no longer says "Every action here is one Plan 1 ... can actually produce today".
  - `apps/web/app/lib/audit.test.ts` gains `"labels a Plan 2 action"`: `actionLabel("inventory.po.receive")` is `"Stock received"`.
- [ ] **Step 4: Run.**
  - `cd apps/worker && npx vitest run test/audit-labels.test.ts`;
  - `cd apps/web && npx vitest run app/lib/audit.test.ts && npx tsc`;
  - `npm run lint` (root).

  Expected: all pass.
- [ ] **Step 5: Commit.** `"feat(activity): label and group every audit action"`

---

## After the last task

- Run the whole gate once from the repo root: `npm run check-types && npm test && npm run lint`.
- **Confirm the registry:**
  - `ROUTE_AUDIT` has no `"pending"` outside the Plan 3 proxy block.
  - `CRON_AUDIT` and `QUEUE_AUDIT` have none at all.
  - `PENDING_CEILING === 7`.
- **What a passing run looks like:** after merge, staging's Activity page shows the new labels for a service edit, and no "Unlabelled change" rows appear for it. (A failing run is a gap row carrying that request's id.)
- The owner merges. CI deploys the API worker (`packages/audit/**` and `apps/worker/**` are in Deploy Worker's paths) and Pages (`apps/web/**`). No background worker changes in this plan, so there are no manual deploys.
