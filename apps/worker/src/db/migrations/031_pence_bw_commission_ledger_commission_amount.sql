-- WS-4: money REAL (pounds) -> INTEGER (pence).
-- bw_commission_ledger.commission_amount -> commission_amount_pence.
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bw_commission_ledger.commission_amount

ALTER TABLE bw_commission_ledger ADD COLUMN commission_amount_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bw_commission_ledger SET commission_amount_pence = CAST(ROUND(commission_amount * 100) AS INTEGER);

ALTER TABLE bw_commission_ledger DROP COLUMN commission_amount;
