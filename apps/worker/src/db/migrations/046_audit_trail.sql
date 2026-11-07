-- Audit trail (spec docs/superpowers/specs/2026-09-26-audit-trail-design.md).
-- audit_log is append-only: the triggers below allow only the sealer's
-- one-time columns and deletion after 6 years.

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL,
  seq           INTEGER UNIQUE,
  sealed_at     TEXT,
  archived_at   TEXT,
  archive_key   TEXT,
  entry_hash    TEXT NOT NULL,
  chain_hash    TEXT,
  actor_type    TEXT NOT NULL,
  actor_ref     TEXT,
  actor_role    TEXT,
  via           TEXT NOT NULL,
  action        TEXT NOT NULL,
  phase         TEXT NOT NULL,
  outcome       TEXT,
  reason        TEXT,
  shop_id       TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  changes_json  TEXT,
  details_json  TEXT,
  request_id    TEXT,
  parent_id     TEXT,
  worker        TEXT NOT NULL,
  ip_ref        TEXT,
  historical    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_log_shop_time ON audit_log (shop_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_time ON audit_log (actor_ref, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_time ON audit_log (action, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log (occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_parent ON audit_log (parent_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_request ON audit_log (request_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_unsealed ON audit_log (occurred_at) WHERE sealed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_unarchived ON audit_log (seq) WHERE sealed_at IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_subjects (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  user_id       TEXT,
  shop_id       TEXT,
  display_name  TEXT,
  email         TEXT,
  ip            TEXT,
  day           TEXT,
  created_at    TEXT NOT NULL,
  redact_after  TEXT,
  redacted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_subjects_ip_day ON audit_subjects (kind, day, ip);
CREATE INDEX IF NOT EXISTS idx_audit_subjects_shop ON audit_subjects (shop_id);
CREATE INDEX IF NOT EXISTS idx_audit_subjects_redact ON audit_subjects (redact_after) WHERE redacted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_seal_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  holder               TEXT,
  lease_until          TEXT,
  last_verified_seq    INTEGER NOT NULL DEFAULT 0,
  walk_cursor_seq      INTEGER NOT NULL DEFAULT 0,
  expired_through_seq  INTEGER NOT NULL DEFAULT 0,
  expired_chain_hash   TEXT
);

INSERT OR IGNORE INTO audit_seal_state (id) VALUES (1);

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
WHEN OLD.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2192 days')
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_seal_only
BEFORE UPDATE ON audit_log
WHEN NOT (
  OLD.id IS NEW.id AND OLD.occurred_at IS NEW.occurred_at AND OLD.entry_hash IS NEW.entry_hash
  AND OLD.actor_type IS NEW.actor_type AND OLD.actor_ref IS NEW.actor_ref AND OLD.actor_role IS NEW.actor_role
  AND OLD.via IS NEW.via AND OLD.action IS NEW.action AND OLD.phase IS NEW.phase
  AND OLD.outcome IS NEW.outcome AND OLD.reason IS NEW.reason AND OLD.shop_id IS NEW.shop_id
  AND OLD.entity_type IS NEW.entity_type AND OLD.entity_id IS NEW.entity_id
  AND OLD.changes_json IS NEW.changes_json AND OLD.details_json IS NEW.details_json
  AND OLD.request_id IS NEW.request_id AND OLD.parent_id IS NEW.parent_id
  AND OLD.worker IS NEW.worker AND OLD.ip_ref IS NEW.ip_ref AND OLD.historical IS NEW.historical
  AND (OLD.seq IS NULL OR OLD.seq IS NEW.seq)
  AND (OLD.sealed_at IS NULL OR OLD.sealed_at IS NEW.sealed_at)
  AND (OLD.chain_hash IS NULL OR OLD.chain_hash IS NEW.chain_hash)
  AND (OLD.archived_at IS NULL OR OLD.archived_at IS NEW.archived_at)
  AND (OLD.archive_key IS NULL OR OLD.archive_key IS NEW.archive_key)
)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
