# Phase 6 Implementation Plan — Reliability & Correctness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reminders that deliver instead of silently dropping, timezone-correct slots year-round, no poisoned init caches, defensive JSON parsing, and a web app that degrades gracefully instead of white-screening.

**Architecture:** Branch `remediation/phase-6` stacked on `remediation/phase-5`. Worker: queue scheduling + `src/lib/timezone.ts` + migration 020. Workers: promise-cache fixes (4 sites). Web: root + layout ErrorBoundaries, defensive loaders. Shared: `safeJsonParse` in `@repo/utils` (raw-TS package, directly importable).

### Task 1: Reminder delivery (T6.1)

Cloudflare Queues `delaySeconds` max is 43200 (12h); reminders are typically 24h+ out, so scheduling hops: send with `delaySeconds = clamp(sendAt - now, 0, 43200)`; the consumer, on a still-future `sendAt`, calls `msg.retry({ delaySeconds: clamp(remaining, 60, 43200) })` instead of `msg.ack()` (the current code acks and the reminder is lost — only the 08:00 cron catches it).

- [ ] `bookings.ts` enqueue: add computed `delaySeconds` to `QUEUE.send`.
- [ ] `index.ts` consumer: replace ack-drop with delayed retry.
- [ ] `wrangler.toml` (+staging, +dev): consumer `max_retries` 3 → 10 (retries are also scheduling hops now).
- [ ] Unit test the clamp/hop math (pure helper `reminderDelaySeconds(sendAt, now)` in `src/services/reminder.ts`).

### Task 2: Poisoned init caches (T6.2)

4 sites cache a possibly-rejected promise forever (first failure → every request fails until isolate restart):
`apps/workers/booking/src/index.ts:13-18`, `apps/workers/booking/src/db/ensure-schema.ts:186-189`, `apps/workers/chatbot/src/index.ts:145-148`, `apps/workers/chatbot/src/ensure-schema.ts:57-61`.

- [ ] Each: `schemaOnce = ensure(...).catch((e) => { schemaOnce = null; throw e; })` so the next request retries.

### Task 3: Timezone-correct slots (T6.6)

`shops.timezone` exists in `@repo/types` but neither in the schema nor the slot math (everything UTC → slots off by 1h during BST for a UK business).

- [ ] Migration `020_shop_timezone.sql`: `ALTER TABLE shops ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/London';` + same column in `schema.sql` (rolling snapshot rule).
- [ ] `src/lib/timezone.ts`: `zonedTimeToUtc(date, "HH:MM", tz)` via the Intl offset trick (two-pass for DST transitions). Unit tests: GMT date, BST date, the 2027 spring-forward Sunday.
- [ ] `services/slots.ts`: read the shop's timezone (one query) and build slot instants with `zonedTimeToUtc` instead of `T${time}:00Z`.
- [ ] Tests: existing January expectations unchanged (GMT=UTC); new July test expects 08:00Z for a 09:00 Europe/London schedule.

### Task 4: Safe JSON parsing (T6.5)

- [ ] `@repo/utils`: `safeJsonParse<T>(raw: string | null | undefined): T | null` (try/catch).
- [ ] Add `"@repo/utils": "*"` to worker deps; replace the bare `JSON.parse` calls on KV/DB content in `routes/shops.ts` (9), `routes/ai.ts` (2), `services/slots.ts` (1) with null-handled `safeJsonParse` (treat null as cache miss / absent theme).

### Task 5: Web error boundaries + defensive loaders (T6.3, T6.4)

- [ ] `app/components/ErrorScreen.tsx`: friendly branded error component (status-aware via `isRouteErrorResponse`).
- [ ] `root.tsx`: export `ErrorBoundary` rendering it (full-document fallback).
- [ ] Layout boundaries: `admin.tsx`, `dev.tsx`, `staff.tsx`, `$shopSlug.tsx` export `ErrorBoundary` (keeps chrome, swaps content).
- [ ] Sweep loaders calling the API without try/catch (known: `account.tsx`, `admin.revenue.tsx`, `api.jobs.$jobId.status.tsx`; grep for the rest); wrap to return an error field the page renders (or rethrow as 502 Response where a boundary is the right UX). Delete stale `.js` twins is automatic (clean script).
- [ ] Verification: `check-types`, `lint`, full build (no web test harness — explicit gap, tracked under NFR-Q2 debt).

### Task 6: Verify + ship

- [ ] Worker suite green (incl. new tz/reminder tests), tsc 0, root build green; commits per task; stacked PR base `remediation/phase-5`. Staging: deploy + apply migration 020 (validates the new-migration runbook end-to-end).

## Self-review
T6.1✓(1) T6.2✓(2) T6.3✓(5) T6.4✓(5) T6.5✓(4) T6.6✓(3). Queue retry budget interaction called out (max_retries raised). Web verification limitation stated, not hidden.
