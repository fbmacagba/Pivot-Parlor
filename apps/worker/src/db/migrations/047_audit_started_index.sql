-- Ruling 26 (Task 8 audit-trail fix round 1): the sealer's stale-started
-- scan is bounded to occurred_at in [cutoff - 7 days, cutoff), and still
-- needs an index on occurred_at for started rows to avoid scanning 6 years
-- of audit_log history every minute.

CREATE INDEX IF NOT EXISTS idx_audit_log_started ON audit_log (occurred_at) WHERE phase = 'started';
