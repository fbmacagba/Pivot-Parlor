# Phase 2 Implementation Plan — Booking Integrity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make double-booking impossible at the database level, return 409/400 instead of 500s for slot conflicts and bad input, and close a staff-shop validation gap found during implementation.

**Architecture:** One migration (partial unique index) + surgical changes to the public booking route. Branch `remediation/phase-2` stacked on `remediation/phase-0-1`.

**Scope notes:**
- SQLite has no exclusion constraints, so the unique index guards the *same-start-time* race (the realistic one — customers pick from a fixed slot grid). Overlapping-but-different starts remain guarded by the existing `checkSlotConflict` pre-check; residual risk accepted and documented.
- Discovered in implementation: `POST /api/bookings` validates the service belongs to the shop but **not the staff member** — body-supplied `staff_id` is trusted. Fixed here as T2.4 (it's booking integrity).

### Task 1: Migration 018 (T2.1)

**Files:** Create `apps/worker/src/db/migrations/018_unique_booking_slot.sql`.

```sql
-- One active booking per staff member per start time, enforced by the DB.
-- Cancelled/no-show bookings free their slot. Overlap with different start
-- times is still guarded by the application-level conflict check
-- (checkSlotConflict) — SQLite has no exclusion constraints.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot
ON bookings(staff_id, start_time)
WHERE status NOT IN ('cancelled', 'no_show');
```

- [ ] **Pre-flight (operator, before applying to prod):** check for existing violators:
  ```bash
  cd apps/worker && npx wrangler d1 execute pivot-parlor-db --remote --command "SELECT staff_id, start_time, COUNT(*) n FROM bookings WHERE status NOT IN ('cancelled','no_show') GROUP BY staff_id, start_time HAVING n > 1"
  ```
  Any rows → cancel the duplicates before applying 018. (Attempted from this session; requires authed wrangler.)

### Task 2: Route hardening (T2.2, T2.3, T2.4)

**Files:** Modify `apps/worker/src/routes/bookings.ts:109-148`; Test `apps/worker/test/bookings.integrity.test.ts`.

- [ ] Failing tests: (a) invalid `start_time` → 400 not 500; (b) `staff_id` from another shop → 404; (c) booking succeeds (201/200); (d) direct second `createBooking` for same staff+start throws UNIQUE; (e) route returns 409 for an occupied slot; (f) cancelling frees the slot for re-booking.
- [ ] Implementation (in order, after the existing service validation):

```ts
// Staff member must belong to the shop and be active (body input — not covered by URL scoping)
const staffMember = await getStaffById(c.env.DB, staff_id);
if (!staffMember || staffMember.shop_id !== shop_id || staffMember.is_active !== 1) {
  return c.json({ success: false, error: "Staff member not found" }, 404);
}

const startDate = new Date(start_time);
if (Number.isNaN(startDate.getTime())) {
  return c.json({ success: false, error: "start_time must be a valid ISO date-time" }, 400);
}
```

and wrap the insert:

```ts
try {
  await createBooking(c.env.DB, { ... });
} catch (err) {
  if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
    return c.json({ success: false, error: "This time slot is no longer available" }, 409);
  }
  throw err;
}
```

(`getStaffById` already imported in bookings.ts for the confirmation email.)

### Task 3: Verify + commit

- [ ] Full suite green; `tsc` ≤ 23-error baseline; root build passes; commits per task.

## Self-review
- T2.1✓(Task1) T2.2✓(Task2 insert wrap) T2.3✓(Task2 date check) + discovered T2.4 staff validation✓(Task2). No placeholders; types come from existing queries.ts helpers.
