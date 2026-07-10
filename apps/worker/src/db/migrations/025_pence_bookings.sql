-- WS-4: money REAL (pounds) -> INTEGER (pence).
-- bookings.amount -> amount_pence, bookings.commission -> commission_pence.
--
-- replay-guard: skip-if-column-absent bookings.amount
--
-- The guard column (amount) is dropped LAST so a crash anywhere inside this
-- file leaves the guard present and the file re-runs to completion. The one
-- unrecoverable window is a crash exactly between the two DROPs (the re-run's
-- UPDATE would reference the already-dropped commission column) — production
-- is backed up before this migration is applied.

ALTER TABLE bookings ADD COLUMN amount_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN commission_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bookings SET
  amount_pence = CAST(ROUND(amount * 100) AS INTEGER),
  commission_pence = CAST(ROUND(commission * 100) AS INTEGER);

ALTER TABLE bookings DROP COLUMN commission;
ALTER TABLE bookings DROP COLUMN amount;
