-- WS-4: money REAL (pounds) -> INTEGER (pence).
-- bw_booking_state.deposit_amount -> deposit_amount_pence,
-- total_amount -> total_amount_pence (stays nullable: NULL = not checked out).
-- promo_discount_percent stays REAL — it is a rate, not a money amount.
--
-- replay-guard: skip-if-column-absent bw_booking_state.deposit_amount

ALTER TABLE bw_booking_state ADD COLUMN deposit_amount_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bw_booking_state ADD COLUMN total_amount_pence INTEGER;

UPDATE bw_booking_state SET
  deposit_amount_pence = CAST(ROUND(deposit_amount * 100) AS INTEGER),
  total_amount_pence = CAST(ROUND(total_amount * 100) AS INTEGER);

ALTER TABLE bw_booking_state DROP COLUMN total_amount;
ALTER TABLE bw_booking_state DROP COLUMN deposit_amount;
