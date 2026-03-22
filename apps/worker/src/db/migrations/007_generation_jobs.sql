-- Migration 007: async site generation job tracking

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  stage TEXT DEFAULT 'research',
  research_output TEXT,
  build_output TEXT,
  audit_output TEXT,
  error TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id)
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_shop_id ON generation_jobs(shop_id);
