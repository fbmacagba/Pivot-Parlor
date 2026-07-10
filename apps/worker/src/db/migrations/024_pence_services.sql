-- WS-4: money REAL (pounds) -> INTEGER (pence). services.price -> price_pence.
--
-- replay-guard: skip-if-column-absent services.price
--
-- The guard line above is a directive read by scripts/migrate.mjs and the two
-- test apply-schema.ts files: when the old column is already gone (fresh
-- database built from the schema.sql snapshot, or this file already ran) the
-- whole file is recorded as applied without executing. On a database still at
-- the old shape it executes normally. If a run dies between the statements
-- below, the old column still exists, so a re-run re-executes the file
-- (duplicate ADD COLUMN errors are benign) and completes the conversion.

ALTER TABLE services ADD COLUMN price_pence INTEGER NOT NULL DEFAULT 0;

UPDATE services SET price_pence = CAST(ROUND(price * 100) AS INTEGER);

ALTER TABLE services DROP COLUMN price;
