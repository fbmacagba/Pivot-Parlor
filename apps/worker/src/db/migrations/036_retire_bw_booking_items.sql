-- WS-3 Phase 1: retire bw_booking_items — the sales spine (035) replaces it.
--
-- replay-guard: skip-if-column-absent bw_booking_items.id
--
-- Historical line items of COMPLETED bookings are preserved as one 'stripe'
-- sale per booking (receipts and reporting keep working); legacy 'tip' items
-- fold into the sales.tip_pence header column. Items of in-flight bookings
-- are deliberately NOT migrated: the rewritten checkout derives the base
-- service price from bookings.amount_pence and creates its own sale, so
-- nothing reads pre-checkout item rows any more.
--
-- The booking worker's ensure-schema.ts no longer re-creates this table
-- (block removed in the same change) — the drop is final.

INSERT INTO sales (id, shop_id, booking_id, subtotal_pence, tip_pence, total_pence, tender_type, status, created_at, completed_at)
SELECT lower(hex(randomblob(16))),
       bi.shop_id,
       bi.booking_id,
       SUM(CASE WHEN bi.item_type IN ('service','product') THEN bi.total_price_pence ELSE 0 END),
       SUM(CASE WHEN bi.item_type = 'tip' THEN bi.total_price_pence ELSE 0 END),
       SUM(bi.total_price_pence),
       'stripe',
       'completed',
       MIN(bi.created_at),
       MIN(bi.created_at)
FROM bw_booking_items bi
JOIN bookings b ON b.id = bi.booking_id AND b.status = 'completed'
GROUP BY bi.booking_id, bi.shop_id;

INSERT INTO sale_items (id, sale_id, shop_id, item_type, service_id, name, quantity, unit_price_pence, line_total_pence, is_commissionable, created_at)
SELECT lower(hex(randomblob(16))),
       s.id,
       bi.shop_id,
       bi.item_type,
       bi.service_id,
       COALESCE(bi.name, ''),
       bi.quantity,
       bi.unit_price_pence,
       bi.total_price_pence,
       bi.is_commissionable,
       bi.created_at
FROM bw_booking_items bi
JOIN sales s ON s.booking_id = bi.booking_id
WHERE bi.item_type IN ('service','product');

DROP TABLE bw_booking_items;
