-- WS-4: money REAL (pounds) -> INTEGER (pence). bw_booking_items.unit_price -> unit_price_pence.
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bw_booking_items.unit_price

ALTER TABLE bw_booking_items ADD COLUMN unit_price_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bw_booking_items SET unit_price_pence = CAST(ROUND(unit_price * 100) AS INTEGER);

ALTER TABLE bw_booking_items DROP COLUMN unit_price;
