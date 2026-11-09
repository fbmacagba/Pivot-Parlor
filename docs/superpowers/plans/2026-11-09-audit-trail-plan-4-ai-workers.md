# Audit trail Plan 4: the AI workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model call and image generation made by the background AI workers, and every site regeneration's final result, leaves an audit entry. A regeneration's entries name the person who clicked Regenerate.

**Architecture:** The site pipeline (research → text and images → assembler) and the shop-site chatbot use `@repo/audit` directly.
- **Actors:** queue stages record `actor_type = system`, `via = queue`, with the generation job id as `request_id`. The chatbot records an anonymous visitor with an IP subject.
- **Model and image calls:** each one is a two-step `ai.call` (`started`, then `outcome`). A refused `started` write means the call never runs.
- **Exactly one `site.regenerate.complete` per job:** whichever stage ends the job writes it in the same D1 batch as its terminal write. Its id is derived from the job id, so a second delivery cannot add another.
- **Who clicked:** `origin_actor_ref` rides every queue hop, and the viewer resolves it to a name.

**Tech Stack:** Cloudflare Workers, Queues, D1, KV, R2; TypeScript; `@repo/audit`, `@repo/llm`; vitest (plain Node for research, text, images and chatbot; `@cloudflare/vitest-pool-workers` for the builder).

**Spec:** `docs/superpowers/specs/2026-09-26-audit-trail-design.md`, sections 3.3, 4.1, 4.4, 4.5, 4.6 and 9 (step 4). Earlier plans in the same folder: `2026-09-26-audit-trail-foundation.md` (Plan 1), `2026-11-08-audit-trail-plan-2-api-routes.md`, `2026-11-08-audit-trail-plan-3-booking-worker.md`. Plan 3 split the original "Plan 3" in two and named this plan as the AI-worker half.

## Global Constraints

- No migration. `ai.call` and `site.regenerate.complete` are already in the action catalogue (`packages/audit/src/actions.ts`); the next migration stays `051`.
- No new external dependency. Packages added to a workspace (`vitest`, `@cloudflare/vitest-pool-workers`, `@repo/audit`) are already used in this repo. Follow the repo's package-validation rules for any lock change.
- Never store a prompt, a model reply, a visitor message, a provider error body, an API key or a raw IP in `details_json` or `reason`. `reason` comes from `errorReason` (error name plus HTTP status) or a fixed code.
- `estimated_cost_usd` is rounded to 6 decimal places, the same as `round6` in `packages/llm/src/usage.ts` and the API's `ai-generator.ts`.
- Money stays out of scope: no pence fields change.
- No em or en dashes in user-facing text: viewer copy, error strings.
- Background workers deploy by hand, in production only (none has a staging environment). Deploying them, and any paid production regeneration, needs the owner's explicit go-ahead.
- Commits: run `aramid check --staged`, and `npx eslint` on every changed file including tests, before each commit. Stage explicit paths only (`.superpowers/` and `.impeccable/` are untracked in this worktree). Never use `--no-verify`.

## Rulings made in planning (veto any)

Each ruling: what was decided, then why, then what it costs if wrong.

1. **The `audit` worker (`apps/workers/audit`, script `pivot-parlor-audit`) is excluded.**
   - Why: its only trigger is `site-audit-queue`, and the Cloudflare queues API shows that queue with **no producers** (checked 2026-11-09). No code sends to it. The script was last deployed 2026-07-06. Instrumenting it would record nothing, and converting it to a workspace would only add to the lock file.
   - Follow-up for the owner: retiring the worker and queue is destructive. Note too that `pivot-parlor-images` still consumes an orphaned `site-build-queue`.
   - Cost if wrong: a revived site-audit path would run unrecorded until instrumented.
2. **`generation_jobs` progress writes are not separate entries.** That covers `running`, the stage changes and the KV job mirror, all bookkeeping. The entries are each `ai.call` and the one terminal `site.regenerate.complete`.
   - Cost if wrong: the trail shows when a job ended, not each stage boundary. Those times stay in `generation_jobs.updated_at`.
3. **Exactly one `site.regenerate.complete` per job.** Its id is `completionEntryId(jobId)`, a UUID-shaped value from SHA-256 of `"site.regenerate.complete:" + jobId`. A second terminal batch for the same job fails on the `audit_log` primary key and rolls back whole. The stage then re-reads the job: when it is already `complete` or `failed` it stops quietly; otherwise it rethrows.
   - Why not a NULL-into-NOT-NULL guard: `generation_jobs.status` is nullable (migration 007 has `status TEXT DEFAULT 'queued'`). The primary key is the one guard this project fully controls.
   - Cost if wrong: none to correctness; the id is simply not random.
4. **The terminal job write is idempotent too.** It runs `UPDATE generation_jobs SET status = ?, stage = ?, error = ?, updated_at = ? WHERE id = ? AND COALESCE(status, 'queued') NOT IN ('complete', 'failed')`.
5. **A refused audit write fails the job.** When an `ai.call` started write throws `AuditWriteError`:
   - the call never runs, and the error escapes every attempt loop and error-collection catch;
   - the stage ends the job with `failed`, error `Could not record this action; nothing was changed.`, and its completion entry;
   - **images included**: today a failed image falls through to "assemble without images", which would publish a site with no photos because the trail was down.

   If the terminal batch itself cannot be written, the stage falls back to today's best-effort job failure write and logs `[audit] job failed without its completion entry`. The `started` row's missing outcome is what the sealer reports.

   Cost if wrong: a D1 blip fails a regeneration that a retry might have saved. The owner can click Regenerate again.
6. **`origin_actor_ref` is optional everywhere.**
   - It is accepted only in the shape `^subj_user_[A-Za-z0-9-]{1,128}$` (`originActorRef()`), else null.
   - It rides every queue send: research's 3, text's 1, images' 4, and the assembler's own 2 wait-path re-sends.
   - Every entry of the job carries it in `details.origin_actor_ref`.
   - Messages already in flight at deploy time carry none and record null.
7. **The assembler's publish becomes one batch:**
   - the `shop_sites` write, as one upsert (`INSERT ... ON CONFLICT(shop_id) DO UPDATE`; migration 003 has a unique index on `shop_id`, and the insert-only `id` and `template` are left out of the update set);
   - the owner-palette write, when chosen;
   - the guarded job completion;
   - the shop activation;
   - the completion entry.

   The review path (migration 049) becomes one batch the same way: the candidate upsert, the job completion and the entry. The completion's `changes` for the shop come from a read just before the batch (`status`, `is_active`), recorded only when they differ.

   Cost if wrong: a pre-read can be a moment stale. That is acceptable here: only the pipeline writes these fields.
8. **`recordAiUsage` returns `UsageCost | null`.** Today it returns `void`. The `ai.call` outcome reuses that cost, so the price list is read once per call.
9. **The chatbot moves onto `recordAiUsage`.** Its `ai_usage_log` cost changes from the flat `total * 0.000000075` to model-list pricing, the same as research and text.
   - Cost: chatbot cost history changes basis at the deploy date. The PR states it.
10. **Out of scope, listed as follow-ups:**
    - the builder's runtime `ALTER TABLE` in `ensureShopSitesSeoColumns`, which predates this plan and conflicts with the assert-only rule;
    - image-generation cost in `ai_usage_log` (images writes no usage rows today);
    - retiring the dead `audit` worker.

## Review Focus

- **A redelivered or re-sent queue message must not double-record.** Assembler wait paths re-send their own message, and Queues deliver at least once. Expected: one completion entry per job. Pinned in Tasks 2 and 7.
- **A refused audit write in the middle of the pipeline.** Expected: no model call, the job reads `failed` (never stuck on `running`), and no site is published without photos. Pinned in Tasks 4, 5 and 6.
- **A message from before the deploy, without `origin_actor_ref`.** Expected: entries record `origin_actor_ref: null`, and nothing throws. Pinned in Tasks 4 to 7.
- **A chatbot request with no `CF-Connecting-IP`.** Expected: an anonymous entry with no IP subject, never a shared placeholder subject. Pinned in Task 8.
- **A forged `origin_actor_ref`, from a message body never written by the API.** Expected: anything not shaped `subj_user_…` records null. Pinned in Task 2.

---

### Task 1: Workspaces, dependencies and the shared test fake

**Files:**
- Modify: root `package.json` (`workspaces`: add `apps/workers/builder`, `apps/workers/images`)
- Delete: `apps/workers/builder/package-lock.json`, `apps/workers/images/package-lock.json`
- Modify: `apps/workers/{research,text,chatbot,builder,images}/package.json` (dependency `"@repo/audit": "*"`; images gains `vitest` and a `test` script; builder gains `@cloudflare/vitest-pool-workers` and `check-types`)
- Create: `packages/audit/src/testing.ts`; modify `packages/audit/package.json` (`exports["./testing"]`)
- Test: `packages/audit/test/testing.test.ts`
- Modify: `package-lock.json` (via `npm install` at the root)

**Interfaces:**
- Produces: `fakeAuditDb(opts?: { failAuditWrites?: "started" | "outcome" | "all"; failOnSql?: RegExp }): { db: D1Database; rows: AuditRowRecord[]; statements: { sql: string; args: unknown[] }[] }`, exported from `@repo/audit/testing`.
  - It records every `audit_log` INSERT a batch commits (keyed by `AUDIT_COLUMNS`), and every other statement in order.
  - `first()` returns null; `run()` resolves `{ meta: { changes: 1 } }`.
  - `failAuditWrites` makes a batch holding an `audit_log` INSERT of that phase throw. `failOnSql` makes any statement whose SQL matches throw.

- [ ] **Step 1: Write the failing test**, `packages/audit/test/testing.test.ts`:
  - `"records a system entry written through the recorder"`: a recorder over the fake writes `day.close`; `rows` has one row with `action === "day.close"`.
  - `"failAuditWrites: started refuses the started row and nothing else"`: `run()` rejects with `AuditWriteError`; `rows` is empty.
  - `"answers first() with null so an IP actor gets a fresh subject"`: an `anonymous` actor with `ip: "203.0.113.9"` writes an entry whose `ip_ref` matches `/^subj_ip_/`.
- [ ] **Step 2:** Run `cd packages/audit && npx vitest run test/testing.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `fakeAuditDb`** in `packages/audit/src/testing.ts`, and add the `./testing` export.
- [ ] **Step 4: Convert the workspaces.**
  - Add the two workspaces and delete the two nested lock files.
  - Add the dependencies, then run `npm install` at the root.
  - Confirm `npm ls @repo/audit` lists all five workers.
- [ ] **Step 5:** Run `npx turbo run check-types test --force`. Expected: all green, with `pivot-parlor-images` and `pivot-parlor-assembler` now listed as tasks.
- [ ] **Step 6: Commit:** `chore(workers): builder and images join the workspaces; shared audit test fake`.

### Task 2: Pipeline audit helpers in `@repo/audit`

**Files:**
- Create: `packages/audit/src/pipeline.ts`; export it from `packages/audit/src/index.ts`
- Test: `packages/audit/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `createAuditRecorder`, `AuditRecorder`, `AuditWriteError` (existing), and `fakeAuditDb` (Task 1).
- Produces:
  - `originActorRef(x: unknown): string | null` accepts only `^subj_user_[A-Za-z0-9-]{1,128}$`.
  - `queueAudit(db: D1Database, worker: string, jobId: string | null): AuditRecorder` gives a system actor with `via: "queue"` and `requestId: jobId`.
  - `interface AiCallMeasure { model: string; route: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costBasis: string | null }`
  - `auditAiCall<T>(rec: AuditRecorder, meta: { purpose: string; model: string; shopId: string | null; origin: string | null }, fn: () => Promise<T>, measure: (r: T) => AiCallMeasure): Promise<T>`
    - It is `rec.run()` with `action: "ai.call"`, `entityType: "shop"` and `entityId: shopId`.
    - The started details are `{ purpose, model, origin_actor_ref }`.
    - The outcome details are `{ purpose, model, route, input_tokens, output_tokens, estimated_cost_usd, cost_basis, origin_actor_ref }`.
  - `completionEntryId(jobId: string): Promise<string>` returns a UUID-shaped id (8-4-4-4-12 hex) from SHA-256 of `"site.regenerate.complete:" + jobId`.
  - `finishJobStatements(db: D1Database, rec: AuditRecorder, job: { jobId: string; shopId: string; status: "complete" | "failed"; stage: string; error: string | null; origin: string | null; details?: Record<string, unknown>; changes?: Record<string, [unknown, unknown]> | null }): Promise<D1PreparedStatement[]>`
    - It returns the idempotent terminal job UPDATE (Ruling 4) followed by the completion entry's statements.
    - The entry: `id = completionEntryId(jobId)`, `outcome` succeeded for `complete` and failed for `failed`, `reason` the stage error code, `entityType: "shop"`.
    - Its details: `{ job_id, stage, result: status, origin_actor_ref, ...details }`.
  - `finishJob(db, rec, job, extra?: D1PreparedStatement[]): Promise<"finished" | "already_finished">`
    - It runs one batch of `[...extra, ...finishJobStatements]`.
    - On a throw it re-reads `generation_jobs.status`: `complete` or `failed` answers `"already_finished"`, anything else rethrows.

- [ ] **Step 1: Write the failing tests**, `pipeline.test.ts`:
  - `"originActorRef keeps a user subject and drops anything else"`:
    - `"subj_user_abc-1"` is kept;
    - `"subj_ip_x"`, `"subj_user_"`, `"alice@example.com"`, `42` and `null` all become null.
  - `"auditAiCall records started then a measured outcome"`: two rows; the outcome details equal the measure mapped to snake_case, plus purpose and origin.
  - `"auditAiCall never runs the call when the started write is refused"`: with `failAuditWrites: "started"` the call spy is not called, and the rejection is an `AuditWriteError`.
  - `"auditAiCall records a failed outcome and rethrows when the call throws"`: the outcome is `failed`; the reason is `Error` or `Name (HTTP 502)`, never the message.
  - `"completionEntryId is stable per job and UUID-shaped"`: the same input gives the same value, different jobs give different values, and both match `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`.
  - `"finishJobStatements puts the guarded job write before the entry"`: the first statement's SQL contains `COALESCE(status, 'queued') NOT IN ('complete', 'failed')`, and the entry's `id` is `completionEntryId(jobId)`.
- [ ] **Step 2:** Run `cd packages/audit && npx vitest run test/pipeline.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `pipeline.ts`. `finishJob`'s "already finished" path is proven on real D1 in Task 7.
- [ ] **Step 4:** Run the package tests and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(audit): pipeline helpers (ai.call, exactly-once job completion, origin ref)`.

### Task 3: `recordAiUsage` returns the cost it recorded

**Files:**
- Modify: `packages/llm/src/usage.ts`
- Test: `packages/llm/test/usage.test.ts`

**Interfaces:**
- Produces: `recordAiUsage(env, record, log?): Promise<UsageCost | null>`. It returns the cost written (null when unpriced, when there is no usage, or when the insert failed), and still never throws.

- [ ] **Step 1: Write the failing tests:**
  - `"returns the cost it wrote"`: a priced model returns `{ costUsd, basis: "live" }`, equal to the row's `estimated_cost_usd`.
  - `"returns null for an unpriced call"`.
  - `"returns null and does not throw when the insert fails"`.
- [ ] **Step 2:** Run `cd packages/llm && npx vitest run test/usage.test.ts`. Expected: FAIL on the return value.
- [ ] **Step 3:** Implement. Return `cost` after the insert, and `null` from the catch.
- [ ] **Step 4:** Run the llm tests and `npx turbo run check-types`. Expected: PASS; no caller breaks.
- [ ] **Step 5: Commit:** `feat(llm): recordAiUsage returns the cost it recorded`.

### Task 4: Research worker

**Files:**
- Modify: `apps/workers/research/src/index.ts`
- Test: `apps/workers/research/src/audit.test.ts`

**Interfaces:**
- Consumes: `queueAudit`, `auditAiCall`, `finishJob`, `originActorRef` (Task 2); `recordAiUsage` returning `UsageCost | null` (Task 3).
- Produces: every message research sends (`SITE_IMAGES_QUEUE`, `SITE_TEXT_QUEUE`, `SITE_ASSEMBLE_QUEUE`) and the `gen:research` KV payload carry `origin_actor_ref: string | null`. `ResearchQueueMessage` gains `origin_actor_ref?: string | null`, and `parseInput` keeps it through `originActorRef`.

- [ ] **Step 1: Write the failing tests** (plain Node). Drive `processOneMessage` through the default export's `queue()`, with a fake env: `fakeAuditDb`, an in-memory KV, recording queues, and `globalThis.fetch` stubbed to answer a valid research spec.
  - `"each model attempt is an ai.call carrying who clicked"`: one valid attempt gives one started row and one outcome row with `purpose: "site_research"` and `origin_actor_ref: "subj_user_u1"`.
  - `"origin_actor_ref rides every message and the research payload"`: the text, images and assemble sends and the KV payload all carry `"subj_user_u1"`. With `skip_images`, the assemble send carries it.
  - `"a message from before the deploy records null and still runs"`.
  - `"a refused audit write stops the job before any model call"`:
    - `failAuditWrites: "started"` means fetch is never called;
    - the job `UPDATE` sets `failed` with `Could not record this action; nothing was changed.`;
    - nothing is enqueued.
  - `"a job with no valid spec ends with one failed completion entry"`: three invalid replies give one `site.regenerate.complete` row with outcome `failed` and `id === completionEntryId(jobId)`.
- [ ] **Step 2:** Run `cd apps/workers/research && npx vitest run src/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Wrap `chatComplete` and `recordAiUsage` in `auditAiCall` inside `researchJson`, with purpose `site_research`.
  - In the attempt loop's catch, rethrow `AuditWriteError`.
  - Route the three failure exits (no API key, no valid spec, outer catch) through `finishJob` with status `failed`. Keep the KV job mirror write after it.
  - Apply the Ruling 5 fallback when `finishJob` throws.
- [ ] **Step 4:** Run the research tests and `tsc --noEmit`. Expected: PASS, including the existing `facts.test.ts`.
- [ ] **Step 5: Commit:** `feat(research): ai.call entries, job completion entry, origin_actor_ref onward`.

### Task 5: Text worker

**Files:**
- Modify: `apps/workers/text/src/index.ts`
- Test: `apps/workers/text/src/audit.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers and Task 3. The text message's `origin_actor_ref`, which research sends after Task 4.
- Produces: the assemble send carries `origin_actor_ref`.

- [ ] **Step 1: Write the failing tests:**
  - `"the copy call is an ai.call with purpose site_text and the origin"`.
  - `"the assemble send carries origin_actor_ref"`.
  - `"a refused audit write fails the job without calling the model"`.
  - `"a crash ends the job with one failed completion entry"`: through `failJobAfterCrash`; delivered twice, it still leaves one entry.
- [ ] **Step 2:** Run `cd apps/workers/text && npx vitest run src/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Wrap `textJson`'s call in `auditAiCall`.
  - Rethrow `AuditWriteError` from the catch at line ~316.
  - Route `failJobAfterCrash` and every failed-job write through `finishJob`, keeping the Ruling 5 fallback.
  - Keep `crash.test.ts` and `services.test.ts` green: their assertions on the job `UPDATE` stand, now with the guarded SQL.
- [ ] **Step 4:** Run the text tests and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(text): ai.call entries, job completion entry, origin_actor_ref onward`.

### Task 6: Images worker

**Files:**
- Modify: `apps/workers/images/src/index.ts`
- Test: `apps/workers/images/src/audit.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers. The images message's `origin_actor_ref`.
- Produces: all 4 assemble sends (lines ~281, ~300, ~473 and `handOffAfterCrash` ~504) carry `origin_actor_ref`.

- [ ] **Step 1: Write the failing tests.** Stub `fetch` for OpenRouter, and use an R2 fake recording `put`.
  - `"each generated image is one ai.call with its purpose"`: hero, logo, `catalog_0` and so on. The model is the job's `image_model`; tokens come from the response's `usage` when present, else null; `estimated_cost_usd` is null.
  - `"every assemble send carries origin_actor_ref"`, including the crash hand-off.
  - `"a refused audit write fails the job instead of assembling without images"`: no OpenRouter fetch, no R2 put, no assemble send, the job ends `failed`, and there is one failed completion entry.
  - `"a failed image still assembles without it, as today"`: a non-audit failure (OpenRouter 500) records a `failed` outcome for that image's `ai.call` and keeps today's `errors` entry and hand-off.
- [ ] **Step 2:** Run `cd apps/workers/images && npx vitest run src/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Wrap each `openRouterGenerateImage` call in `auditAiCall`. The R2 upload stays outside the call: the call is the model request.
  - Let `AuditWriteError` escape the per-image catches.
  - In `processOne`'s outer catch, end the job through `finishJob` for `AuditWriteError`; any other error keeps the hand-off.
- [ ] **Step 4:** Run the images tests and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(images): ai.call per image, refusal fails the job, origin_actor_ref onward`.

### Task 7: Assembler (builder) on real D1

**Files:**
- Create: `apps/workers/builder/vitest.config.ts` (pool-workers, from `apps/workers/booking/vitest.config.ts`: D1 `DB`, KV `KV`, no outbound), `apps/workers/builder/test/apply-schema.ts` (from booking's, applying `schema.sql` and the full migration chain), and `apps/workers/builder/test/audit-assemble.test.ts`
- Modify: `apps/workers/builder/src/index.ts`. Existing `src/*.test.ts` move under the new config, or keep a second plain-Node project; whichever keeps them running unchanged.

**Interfaces:**
- Consumes: Task 2 helpers. Assemble messages carrying `origin_actor_ref`.
- Produces: none for later tasks.

- [ ] **Step 1: Write the failing tests** on real D1. Seed a shop and a running job, and write the three `gen:*` KV payloads.
  - `"the first publish inserts the site, completes the job, activates the shop and records one entry, together"`:
    - one `shop_sites` row, `status = 'active'`;
    - the job `complete`;
    - the shop `active` and `is_active = 1`;
    - one `site.regenerate.complete`, `succeeded`, with `changes` showing the shop status pair and `details.origin_actor_ref`.
  - `"a second publish for the same shop updates the row and keeps its template"`.
  - `"a redelivered message changes nothing and records nothing"`: the same message twice gives one entry and an unchanged `generated_at`.
  - `"a failing entry leaves the live site and the job untouched"`: make the entry insert fail (a `dbWithBatch`-style proxy, as in booking's tests). The `shop_sites` row and the job status are unchanged, and the stage falls back per Ruling 5.
  - `"the review path stores the candidate, completes the job and records the entry in one batch"`: a live shop's job gives a candidate row, the job `complete` with stage `review`, and one entry with `details.result = "review"`.
  - `"each failure exit ends the job with one failed completion entry"`: missing text after the retries, invalid images KV, invalid text KV, and a candidate-store failure.
  - `"both wait-path re-sends carry origin_actor_ref"`.
  - `"the upsert writes the same columns the old INSERT and UPDATE wrote"`: compare the column lists, `template` and `id` on insert only.
- [ ] **Step 2:** Run `cd apps/workers/builder && npx vitest run test/audit-assemble.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The publish path is one `finishJob` call. Its `extra` is the `shop_sites` upsert, the owner-palette update when set, and the shop activation.
  - The review path is one `finishJob` with the candidate upsert.
  - Every failure exit, and `failJobAfterCrash`, goes through `finishJob` with status `failed`.
  - `deleteJobKeys` and the site cache bust stay after the batch.
- [ ] **Step 4:** Run the builder tests (new and existing) and `tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(assembler): publish and review in one audited batch, exactly one completion entry`.

### Task 8: Chatbot

**Files:**
- Create: `apps/workers/chatbot/src/audit.ts` (worker name, actor from the request, refusal message) and `apps/workers/chatbot/src/registry.ts` (`ROUTE_AUDIT`)
- Modify: `apps/workers/chatbot/src/index.ts`
- Test: `apps/workers/chatbot/test/audit-chat.test.ts`, `apps/workers/chatbot/test/audit-coverage.test.ts`

**Interfaces:**
- Consumes: `createAuditRecorder`, `auditAiCall` (Task 2), `recordAiUsage` (Task 3).
- Produces: `ROUTE_AUDIT = { "POST /chat": "ai.call" }`.

- [ ] **Step 1: Write the failing tests** with `app.request()` in Node against a fake env: `fakeAuditDb`, an in-memory KV, a stubbed `fetch` for the model.
  - `"a reply is one ai.call by an anonymous visitor with an IP subject"`:
    - the `actor_type` is `anonymous` and the `ip_ref` matches `/^subj_ip_/`;
    - `purpose: "chatbot"`;
    - the entity is the shop;
    - no message text appears in any column.
  - `"a request with no CF-Connecting-IP records no IP subject"`.
  - `"a refused audit write answers 503 and never calls the model"`: the body is `{ reply: FALLBACK_REPLY, error: "Could not record this action; nothing was changed." }`.
  - `"the platform referral reply calls no model and writes nothing"`.
  - `"usage is logged through recordAiUsage"`: the `ai_usage_log` insert has `worker_name` `pivot-parlor-chatbot`, `usage_type` `chatbot`, and the `job_id` prefix `public-chat:`.
  - Coverage: `"every mutating route of the chatbot app is declared"`. Enumerate the Hono routes as booking's `audit-coverage.test.ts` does; an undeclared POST fails.
- [ ] **Step 2:** Run `cd apps/workers/chatbot && npx vitest run test/audit-chat.test.ts test/audit-coverage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Wrap `generateReply` in `auditAiCall`, recording with an anonymous actor and the IP (null when absent).
  - Catch `AuditWriteError` and answer 503.
  - Replace the inline `ai_usage_log` insert with `recordAiUsage` inside the measured call (Ruling 9).
- [ ] **Step 4:** Run the chatbot tests and `tsc --noEmit`. Expected: PASS, including `model.test.ts`.
- [ ] **Step 5: Commit:** `feat(chatbot): each reply is an audited ai.call; usage priced from the model list`.

### Task 9: The viewer names who clicked

**Files:**
- Modify: `apps/worker/src/routes/audit.ts` (the `SELECT` gains `origin_name`, a join of `audit_subjects` on `json_extract(l.details_json, '$.origin_actor_ref')`, blank when that subject is redacted)
- Modify: `apps/web/app/routes/dev.activity.tsx` (a system row with an `origin_name` reads "System, started by <name>"; a redacted origin reads "System, started by Redacted")
- Test: `apps/worker/test/audit-api.test.ts` (extend), and `apps/web/app/routes/dev.activity.test.tsx` if a render test exists for the page, else one pure helper test

**Interfaces:**
- Consumes: entries carrying `details.origin_actor_ref` (Tasks 4 to 7).
- Produces: `GET /api/audit` rows carry `origin_name: string | null` and `origin_redacted: boolean`.

- [ ] **Step 1: Write the failing tests:**
  - `"a pipeline entry names who clicked"`: a seeded system entry with a user's `origin_actor_ref` lists with `origin_name` equal to that user's name.
  - `"a redacted origin is never named"`.
  - `"an entry with no origin has origin_name null"`.
  - Web: the label helper returns `"System, started by Sam Example"` / `"System, started by Redacted"` / `"System"`.
- [ ] **Step 2:** Run the two test files. Expected: FAIL.
- [ ] **Step 3:** Implement. Pass the ref as `json_extract`, never by string interpolation.
- [ ] **Step 4:** Run `npx turbo run check-types test --filter=worker --filter=web`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(audit-viewer): name who started a pipeline entry`.

### Task 10: Every consumed queue is declared

**Files:**
- Create: `packages/audit/src/fleet.ts` (exported), holding `PIPELINE_QUEUE_AUDIT: Record<string, AuditAction | { exempt: string }>`:
  - `site-research-queue`, `site-text-queue` and `site-images-queue`: `ai.call`;
  - `site-assemble-queue`: `site.regenerate.complete`;
  - `site-audit-queue`: `{ exempt: "no producer; the audit worker is not deployed from this plan (Plan 4 Ruling 1)" }`.
- Test: `apps/worker/test/audit-queue-fleet.test.ts`

**Interfaces:**
- Consumes: `QUEUE_AUDIT` (`apps/worker/src/audit/registry.ts`) and `PIPELINE_QUEUE_AUDIT`.

- [ ] **Step 1: Write the failing test.**
  - `"every queue a worker consumes is declared"`: `import.meta.glob` the `wrangler.toml` of `apps/worker` and of every `apps/workers/*`, with `?raw`. Collect every `queue = "..."` under a `[[queues.consumers]]` or `[[env.*.queues.consumers]]` header, and expect each to appear in `QUEUE_AUDIT` or `PIPELINE_QUEUE_AUDIT`.
  - `"reads the files it claims to check"`: at least 7 configs read, and the collected set includes `site-assemble-queue` and `pivot-parlor-reminders`.
  - `"an exemption carries a reason"`: every `{ exempt }` value is non-empty.
- [ ] **Step 2:** Run `cd apps/worker && npx vitest run test/audit-queue-fleet.test.ts`. Expected: FAIL (the export is missing).
- [ ] **Step 3:** Implement `fleet.ts`.
- [ ] **Step 4:** Run the test. Expected: PASS. Then check that it fails if `site-text-queue` is deleted from the map, and restore it.
- [ ] **Step 5: Commit:** `test(audit): every consumed queue in the fleet is declared`.

### Task 11: Documentation and the deploy runbook

**Files:**
- Modify: `CLAUDE.md`, "AI / Background Workers":
  - the AI workers record their own entries through `@repo/audit` (system, queue, job id);
  - `builder` and `images` are workspaces;
  - the `audit` worker has no producer and is excluded.
- Create: `docs/runbooks/audit-trail-plan-4-deploy.md`
- Test: none; the root gate runs here.

- [ ] **Step 1: Write the runbook.**
  - **Deploy order, downstream first:** the assembler (`apps/workers/builder`), then text and images, then research. The chatbot is independent. The API deploys through CI on merge (Task 9).
  - Each deploy is `npx wrangler deploy` from the worker directory, run only with the owner's go-ahead.
  - **Verification:**
    - a disposable shop regenerated with `skip_images` and the fast model, on the owner's go-ahead (paid): expect `ai.call` rows from research and text, one `site.regenerate.complete` from the assembler, and "System, started by <owner>" in `/dev/activity`;
    - one message to a demo shop's chatbot: expect one anonymous `ai.call`.
  - **Rollback:** redeploy the previous version per worker (`wrangler rollback`).
- [ ] **Step 2:** Run the root gate:
  - `npm run check-types` exits 0;
  - `npx turbo run test --force` exits 0 with 0 cached;
  - `npm run lint` exits 0.
- [ ] **Step 3: Commit:** `docs: Plan 4 deploy runbook and background-worker audit notes`.

## Follow-ups (owner)

- **Retire `pivot-parlor-audit` and `site-audit-queue`:** no producer since at least 2026-07-06. Also remove the orphaned `site-build-queue` consumer on images. Destructive, so the owner decides.
- **The builder's runtime `ALTER TABLE`** (`ensureShopSitesSeoColumns`): move to assert-only, as WS-8 did for the other workers.
- **Image generation cost:** images writes no `ai_usage_log` rows, so `ai.call` entries for images carry tokens but no cost.
