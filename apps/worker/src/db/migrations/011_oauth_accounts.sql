-- Migration 011: OAuth accounts for social login (Google, Facebook, LinkedIn)
-- Each row links a provider identity to an existing platform_users row.
-- A single user may have multiple OAuth accounts (one per provider).

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id      TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK(provider IN ('google', 'facebook', 'linkedin')),
  provider_id  TEXT NOT NULL,
  email        TEXT NOT NULL,
  name         TEXT,
  avatar_url   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON oauth_accounts(provider, provider_id);
