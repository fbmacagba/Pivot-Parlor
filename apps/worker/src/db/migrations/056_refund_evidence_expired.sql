-- 056: a refund request's evidence file expires.
--
-- Evidence files (photos, screenshots, receipts) hold personal data and are
-- kept for 6 years after the request was decided, the same horizon as the
-- financial record they back up. The nightly retention sweep then deletes the
-- file and clears evidence_key / evidence_name / evidence_type on the request.
-- evidence_expired_at records that a file was there and when it went, so the
-- request never reads as "filed without evidence".
ALTER TABLE refund_requests ADD COLUMN evidence_expired_at TEXT;
