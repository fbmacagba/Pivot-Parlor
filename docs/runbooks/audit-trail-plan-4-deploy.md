# Audit trail Plan 4: deploying the AI workers

Plan 4 makes the AI background workers record their own audit entries. Deploy by hand, only with the owner's go-ahead.

## What ships

- API worker: the audit viewer names who started a pipeline entry (`origin_name`, commit 13c13fb). This deploys through CI on merge to main.
- Assembler, `pivot-parlor-assembler` (`apps/workers/builder`): commits 4caf217 and 66fa800.
- Text, `pivot-parlor-text` (`apps/workers/text`): commit 37046fa.
- Images, `pivot-parlor-images` (`apps/workers/images`): commits 0c71ce2 and 676b34e.
- Research, `pivot-parlor-research` (`apps/workers/research`): commit 4b7c0c4.
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

Each deploy is `npx wrangler deploy` from the worker directory.

Why this order: a new consumer accepts old messages (a message without `origin_actor_ref` records null), and an old consumer ignores the new field. Deploying downstream first means a producer never sends a field to a consumer that cannot cope with it.

## What gets recorded

- research: `ai.call` with purpose `site_research`.
- text: `ai.call` with purpose `site_text`.
- images: `ai.call` with purposes `site_image_hero`, `site_image_logo`, `site_image_catalog_<i>` and `site_image_gallery_<i>`.
- chatbot: an anonymous `ai.call` with purpose `chatbot`.
- assembler: no `ai.call`. It writes one `site.regenerate.complete` per job. Failures in the other stages write it too, with a fixed reason code.

A refused audit write BEFORE a model call fails the job (queue workers) or answers 503 (chatbot). A refused write AFTER the call is logged by the audit package and the work continues. The dangling `started` row later reads as "unknown".

## Verification

Each step runs only on the owner's go-ahead.

1. Regenerate a disposable shop with `skip_images` and the fast model (paid, cents). Expect:
   - `ai.call` rows from research and text with purposes `site_research` and `site_text`, carrying `origin_actor_ref`;
   - one `site.regenerate.complete` (succeeded) from the assembler;
   - "System, started by <owner name>" in `/dev/activity`.
2. Optionally, regenerate once WITH images, to see the `site_image_*` `ai.call` rows. It costs more, and it is the only live check of the images worker.
3. Send one message to a demo shop's chatbot. Expect one anonymous `ai.call` with purpose `chatbot` and a `subj_ip_` subject, and an `ai_usage_log` row whose cost is now priced from the model list (Plan 4 Ruling 9: the chatbot's cost basis changes at the deploy date).

## Rollback

Run `npx wrangler rollback` per worker, in reverse deploy order (research, then text and images, then the assembler). It is safe in any order, for the compatibility reason above. The API follows the normal CI rollback path.

## Follow-ups for the owner

- Retire `pivot-parlor-audit` and `site-audit-queue`: no producer since at least 2026-07-06. Also remove the orphaned `site-build-queue` consumer on images. This is destructive, so the owner decides.
- The builder's runtime `ALTER TABLE` (`ensureShopSitesSeoColumns`): move it to assert-only, as WS-8 did for the other workers.
- Image generation cost: images writes no `ai_usage_log` rows, so `ai.call` entries for images carry tokens but no cost.
