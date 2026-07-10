-- WS-4: money REAL (pounds) -> INTEGER (pence). bookings.commission -> commission_pence.
--
-- replay-guard: skip-if-column-absent bookings.commission
--
-- One column per file, on purpose: the runner executes statements as separate
-- D1 API calls, and an API failure can land between any two of them (it did,
-- on staging). With one column per guarded file every crash boundary is
-- resumable — after ADD the re-run's ADD is benign, after UPDATE the re-run's
-- UPDATE is idempotent (the source column still exists), and after DROP the
-- guard records the file without executing.

ALTER TABLE bookings ADD COLUMN commission_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bookings SET commission_pence = CAST(ROUND(commission * 100) AS INTEGER);

ALTER TABLE bookings DROP COLUMN commission;
