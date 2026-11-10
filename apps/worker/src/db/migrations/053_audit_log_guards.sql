-- Migration 053: close two ways round audit_log's append-only triggers (046).
--
-- 1. Inserts. 046 guards UPDATE and DELETE but not INSERT. SQLite's REPLACE
--    removes a conflicting row without firing DELETE triggers (recursive
--    triggers are off) and never fires UPDATE triggers, so
--    INSERT OR REPLACE could swap an unsealed entry for new content with a
--    freshly computed entry_hash. Nothing stopped a row arriving already
--    sealed or archived either, or with a NULL id (a TEXT PRIMARY KEY accepts
--    NULL). BEFORE INSERT fires before conflict resolution, so this trigger
--    refuses all of those. The recorder (packages/audit) is the only writer and
--    always inserts a new id with the five sealing columns NULL; the sealer and
--    the archive step set those columns later, by UPDATE.
--
-- 2. Deletes. 046 allows a delete once occurred_at is more than 2192 days old,
--    but occurred_at is supplied by the writer. A row written with an old time
--    could be deleted at once, and if it was not sealed yet it sat in no hash
--    chain and no archive, so nothing would show it had gone. This trigger
--    refuses deleting any row that is not both sealed and archived. Retention
--    (apps/worker/src/audit/retention.ts) is the only deleter and already
--    selects sealed, archived rows only.
--
-- Both are new triggers beside 046's, never a drop and recreate:
-- scripts/migrate.mjs runs a file statement by statement, so a drop would leave
-- the log unguarded until the next statement ran. Either trigger refusing is
-- enough to stop the statement.

CREATE TRIGGER IF NOT EXISTS audit_log_insert_new_only
BEFORE INSERT ON audit_log
WHEN NEW.id IS NULL
  OR NEW.seq IS NOT NULL OR NEW.sealed_at IS NOT NULL OR NEW.chain_hash IS NOT NULL
  OR NEW.archived_at IS NOT NULL OR NEW.archive_key IS NOT NULL
  OR EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete_unarchived
BEFORE DELETE ON audit_log
WHEN OLD.sealed_at IS NULL OR OLD.archived_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
