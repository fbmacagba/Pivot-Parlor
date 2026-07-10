-- WS-4: money REAL (pounds) -> INTEGER (pence). bw_booking_items.total_price -> total_price_pence.
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bw_booking_items.total_price

ALTER TABLE bw_booking_items ADD COLUMN total_price_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bw_booking_items SET total_price_pence = CAST(ROUND(total_price * 100) AS INTEGER);

ALTER TABLE bw_booking_items DROP COLUMN total_price;
