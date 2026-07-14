-- 043: Article 28 posture — an auditable record of who accepted the platform's
-- legal terms at onboarding. The shop admin represents the controller entering
-- the Data Processing Agreement (which forms part of the Terms of Service); the
-- row captures the accepting user, their shop, which document (terms_dpa for an
-- admin/controller, terms for staff/developer), its version, and when.
--
-- New onboardings (invite accept) write a row atomically with account creation.
-- Existing accounts predate this and are intentionally NOT backfilled here — a
-- retroactive acceptance would misrepresent when consent was actually given.
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id     TEXT REFERENCES shops(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  document    TEXT NOT NULL,
  version     TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_shop ON legal_acceptances(shop_id);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user ON legal_acceptances(user_id);
