-- WS-4: money REAL (pounds) -> INTEGER (pence). bw_transactions.amount -> amount_pence.
-- One column per guarded file — see 025 for why.
--
-- replay-guard: skip-if-column-absent bw_transactions.amount

ALTER TABLE bw_transactions ADD COLUMN amount_pence INTEGER NOT NULL DEFAULT 0;

UPDATE bw_transactions SET amount_pence = CAST(ROUND(amount * 100) AS INTEGER);

ALTER TABLE bw_transactions DROP COLUMN amount;
