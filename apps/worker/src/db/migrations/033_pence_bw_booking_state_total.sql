-- WS-4: money REAL (pounds) -> INTEGER (pence).
-- bw_booking_state.total_amount -> total_amount_pence (stays nullable:
-- NULL = not checked out yet).
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bw_booking_state.total_amount

ALTER TABLE bw_booking_state ADD COLUMN total_amount_pence INTEGER;

UPDATE bw_booking_state SET total_amount_pence = CAST(ROUND(total_amount * 100) AS INTEGER);

ALTER TABLE bw_booking_state DROP COLUMN total_amount;
