-- WS-4: money REAL (pounds) -> INTEGER (pence).
-- bw_booking_state.deposit_amount -> deposit_amount_pence.
-- promo_discount_percent stays REAL — it is a rate, not a money amount.
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bw_booking_state.deposit_amount

ALTER TABLE bw_booking_state ADD COLUMN deposit_amount_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bw_booking_state SET deposit_amount_pence = CAST(ROUND(deposit_amount * 100) AS INTEGER);

ALTER TABLE bw_booking_state DROP COLUMN deposit_amount;
