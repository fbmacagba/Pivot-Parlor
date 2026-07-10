-- WS-4: money REAL (pounds) -> INTEGER (pence). bookings.amount -> amount_pence.
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bookings.amount

ALTER TABLE bookings ADD COLUMN amount_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bookings SET amount_pence = CAST(ROUND(amount * 100) AS INTEGER);

ALTER TABLE bookings DROP COLUMN amount;
