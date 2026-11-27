-- 054: refund requests. No refund leaves the platform on one tap any more:
-- someone at the shop files a request with a written reason (and, optionally,
-- an evidence file), and the owner or a developer approves or declines it.
-- Approval is the refund route itself: the booking worker's deposit-cancel and
-- sale-refund routes act only on a pending request, and mark it approved once
-- the refund has gone through.
--
-- kind 'deposit' names a booking; kind 'sale' names a sale and carries the
-- requested lines as JSON (the lines approval refunds, not ones sent later).
-- booking_id and sale_id are plain text, not foreign keys: sales lives only in
-- the migration chain, and a request must outlive nothing but its shop.
--
-- status: pending -> approving (claimed by an approval in flight) -> approved,
-- or back to pending when the refund fails; pending -> declined.
-- amount_pence is what the request would return when it was filed;
-- refunded_pence is what approval actually returned.
-- evidence_key names an object in the private audit bucket.

CREATE TABLE IF NOT EXISTS refund_requests (
  id             TEXT PRIMARY KEY,
  shop_id        TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('deposit','sale')),
  booking_id     TEXT,
  sale_id        TEXT,
  lines_json     TEXT,
  amount_pence   INTEGER NOT NULL CHECK (amount_pence >= 0),
  reason         TEXT NOT NULL,
  evidence_key   TEXT,
  evidence_name  TEXT,
  evidence_type  TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approving','approved','declined')),
  requested_by   TEXT NOT NULL,
  requested_at   TEXT NOT NULL,
  reviewed_by    TEXT,
  reviewed_at    TEXT,
  review_note    TEXT,
  refunded_pence INTEGER
);

CREATE INDEX IF NOT EXISTS idx_refund_requests_shop_status ON refund_requests(shop_id, status, requested_at);
CREATE INDEX IF NOT EXISTS idx_refund_requests_booking ON refund_requests(booking_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_sale ON refund_requests(sale_id);
