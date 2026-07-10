-- WS-4: money REAL (pounds) -> INTEGER (pence).
-- bw_commission_ledger.services_amount -> services_amount_pence.
-- commission_rate stays REAL — it is a rate (0.10 = 10%), not a money amount.
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bw_commission_ledger.services_amount

ALTER TABLE bw_commission_ledger ADD COLUMN services_amount_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bw_commission_ledger SET services_amount_pence = CAST(ROUND(services_amount * 100) AS INTEGER);

ALTER TABLE bw_commission_ledger DROP COLUMN services_amount;
