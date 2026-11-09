# Audit trail Plan 4: deploying the AI workers

Plan 4 makes the AI background workers record their own audit entries. Deploy by hand, only with the owner's go-ahead.

## What ships

- The audit viewer names who started a pipeline entry (commit 13c13fb; the email when there is no display name, commit 47d1b0c). It ships through BOTH CI deploys on merge to main, because the branch touches both apps:
  - the API worker (`apps/worker`, `origin_name`) through the "Deploy Worker" workflow (`.github/workflows/deploy-worker.yml`). Its path filters include `apps/worker/**`, `packages/audit/**`, `packages/llm/**` and `package-lock.json`, all changed here. It runs `npm ci`, the type check, the API and booking unit tests and `scripts/migrate.mjs --remote` (nothing pending in this plan), then deploys the booking worker and then the API worker;
  - the Pages app (`apps/web`, the "System, started by" label) through the "Deploy Remix Frontend to Cloudflare Pages" workflow (`.github/workflows/deploy-web.yml`). Its path filters include `apps/web/**`, `package.json` and `package-lock.json`, all changed here. It builds and deploys the `pivot-parlor-web` Pages project.
- API worker: "Import AI usage history" (`POST /api/audit/import-historical`) skips a usage row that already has a live `ai.call` from the same worker (commit 53a7bd3), so a click after the deploy never duplicates a live call as "historical". Ships with the API worker above.
- Assembler, `pivot-parlor-assembler` (`apps/workers/builder`): commits 4caf217, 66fa800 and 10c34d9.
- Text, `pivot-parlor-text` (`apps/workers/text`): commits 37046fa and 10c34d9.
- Images, `pivot-parlor-images` (`apps/workers/images`): commits 0c71ce2, 676b34e and 10c34d9.
- Research, `pivot-parlor-research` (`apps/workers/research`): commits 4b7c0c4, 10c34d9 and d978a3c (a redelivered message for a finished job now does nothing).
- Chatbot, `pivot-parlor-chatbot` (`apps/workers/chatbot`): commits 01b727a and d60ef02.
- The fleet test: commit bcad764.

None of the five background workers has a staging environment. They deploy by hand, to production only.

There is no migration in this plan. The next migration number stays 051.

## Before deploying

No database step is needed. The audit tables are live since Plan 1.

The assembler's publish does not depend on a unique index on `shop_sites.shop_id` (Plan 4 Ruling P14). Do not add a production index check as a gate.

## Deploy order, downstream first

1. The assembler (`apps/workers/builder`).
2. Text and images.
3. Research.

The chatbot is independent and can go at any point.

Before the manual deploys, run `npm ci` once from the repository root, on an up-to-date `main`. The builder and images workers are now root workspaces (root `package.json` `workspaces`), and this plan deleted their nested `package-lock.json` files, so their dependencies (`@repo/audit`, `wrangler`) come only from the root install. Research, text and chatbot were root workspaces already. Then each deploy is `npx wrangler deploy` from the worker directory.

Why this order: a new consumer accepts old messages (a message without `origin_actor_ref` records null), and an old consumer ignores the new field. Deploying downstream first means a producer never sends a field to a consumer that cannot cope with it.

## What gets recorded

- research: `ai.call` with purpose `site_research`.
- text: `ai.call` with purpose `site_text`.
- images: `ai.call` with purposes `site_image_hero`, `site_image_logo`, `site_image_catalog_<i>` and `site_image_gallery_<i>`.
- chatbot: an anonymous `ai.call` with purpose `chatbot`.
- assembler: no `ai.call`. It writes at most one `site.regenerate.complete` per job. Failures in the other stages write it too, with a fixed reason code. A job that fails before its first queue send, or whose terminal write falls back under Ruling 5, ends with none.

A refused audit write BEFORE a model call fails the job (queue workers) or answers 503 (chatbot). A refused write AFTER the call is logged by the audit package and the work continues. The dangling `started` row later reads as "unknown".

## Verification

Each step runs only on the owner's go-ahead.

1. Regenerate a disposable shop with `skip_images` and the fast model (paid, cents). Expect:
   - `ai.call` rows from research and text with purposes `site_research` and `site_text`, carrying `origin_actor_ref`;
   - one `site.regenerate.complete` (succeeded) from the assembler;
   - "System, started by <owner name>" in `/dev/activity`.
2. Optionally, regenerate once WITH images, to see the `site_image_*` `ai.call` rows. It costs more, and it is the only live check of the images worker.
3. Send one message to a NON-demo live shop's chatbot. Expect one anonymous `ai.call` with purpose `chatbot` and a `subj_ip_` subject, and an `ai_usage_log` row whose cost is now priced from the model list (Plan 4 Ruling 9: the chatbot's cost basis changes at the deploy date).
   - A demo shop's chat is scripted in the browser ("Sample assistant · Scripted replies") and never reaches the chatbot worker, so it cannot verify it. The worker also requires a Turnstile token.
   - As of 2026-11-09 every production shop is a demo, so this step waits for the first real shop to go live.

## Rollback

Run `npx wrangler rollback` per worker, in reverse deploy order (research, then text and images, then the assembler). It is safe in any order, for the compatibility reason above. For the API worker, revert the merge on main so CI redeploys, or `npx wrangler rollback` from `apps/worker`; the Pages app rolls back separately (its own deployment history).

## Follow-ups for the owner

- Retire `pivot-parlor-audit` and `site-audit-queue`: no producer since at least 2026-07-06. Also remove the orphaned `site-build-queue` consumer on images. This is destructive, so the owner decides.
- DONE (fix/image-cost-assembler-ddl): the builder's runtime `ALTER TABLE` is replaced by an assert-only check (`apps/workers/builder/src/ensure-schema.ts`). A database missing one of the 12 columns fails the job with reason `schema_out_of_date`, and a static test bans DDL in the assembler's source. No migration was needed: 021, 023, 040 and 042 already own the columns. Production was checked first through the public site API, where all 12 carry real values.
- DONE (same branch): image generation cost. Each answered image call writes an `ai_usage_log` row and carries the cost on its `ai.call`, with `cost_basis` `reported`. The figure is OpenRouter's billed `usage.cost`, never a model-list price: image output is billed at `image_output` ($60/1M for gemini-3.1-flash-image), far above the completion rate the list stores. A response without `usage.cost` stays unpriced.
- (M3) A D1 blip across more than one statement during an images refusal can still let the assembler time out into "assemble without images".
- (M4) The chatbot's chosen-model-then-default fallback is recorded as one `ai.call`, not one per attempt.
- (Final review item 5) Move the four queue workers' duplicated `failJob` into `@repo/audit`.
- (Final review item 2) The assembler's pre-existing race (a job ended without an entry, plus a delivery already past the status read, can commit a `succeeded` entry while the job stays `failed`) needs a mechanism that keeps the entry tied to its effect.
