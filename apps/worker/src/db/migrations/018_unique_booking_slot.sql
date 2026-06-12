-- One active booking per staff member per start time, enforced by the DB.
-- Closes the double-booking race: checkSlotConflict (SELECT) and
-- createBooking (INSERT) are separate non-transactional D1 calls, so two
-- concurrent requests for the same slot could both pass the pre-check.
-- Cancelled/no-show bookings free their slot. Overlap with *different*
-- start times is still guarded by the application-level conflict check —
-- SQLite has no exclusion constraints.
--
-- Pre-flight before applying to an existing database:
--   SELECT staff_id, start_time, COUNT(*) AS n FROM bookings
--   WHERE status NOT IN ('cancelled','no_show')
--   GROUP BY staff_id, start_time HAVING n > 1;
-- must return zero rows (verified clean on production 2026-06-12).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot
ON bookings(staff_id, start_time)
WHERE status NOT IN ('cancelled', 'no_show');
