-- ─── Shops ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shops (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_number     INTEGER NOT NULL UNIQUE,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'beauty_parlor' CHECK(type IN ('beauty_parlor','barber_shop','both')),
  owner_name      TEXT NOT NULL DEFAULT '',
  owner_email     TEXT NOT NULL UNIQUE,
  phone           TEXT NOT NULL DEFAULT '',
  commission_rate REAL NOT NULL DEFAULT 0.10,
  ai_theme        TEXT,
  ai_model        TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  ai_tier         TEXT NOT NULL DEFAULT 'pro',
  is_active       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended')),
  plan            TEXT NOT NULL DEFAULT 'standard',
  timezone        TEXT NOT NULL DEFAULT 'Europe/London',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Platform users ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_users (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name          TEXT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('developer','admin','staff','customer')),
  shop_id       TEXT REFERENCES shops(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Services ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id      TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  price        REAL NOT NULL,
  category     TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ─── Staff ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id      TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES platform_users(id),
  display_name TEXT NOT NULL,
  bio          TEXT,
  avatar_url   TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ─── Staff ↔ Services (many-to-many) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_services (
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

-- ─── Schedules (weekly working hours per staff member) ────────────────────────
CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- ─── Bookings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id         TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id        TEXT NOT NULL REFERENCES staff(id),
  service_id      TEXT NOT NULL REFERENCES services(id),
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT,
  booking_date    TEXT NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','confirmed','completed','cancelled','no_show')),
  notes           TEXT,
  amount          REAL NOT NULL,
  commission      REAL NOT NULL,
  reminder_sent   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Waitlist ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id        TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id       TEXT REFERENCES staff(id),
  service_id     TEXT REFERENCES services(id),
  customer_name  TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  preferred_date TEXT,
  status         TEXT NOT NULL DEFAULT 'waiting'
                 CHECK(status IN ('waiting','notified','booked','expired')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bookings_shop        ON bookings(shop_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_staff       ON bookings(staff_id, booking_date);
CREATE INDEX IF NOT EXISTS idx_schedules_staff      ON schedules(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_shop           ON staff(shop_id);
CREATE INDEX IF NOT EXISTS idx_services_shop        ON services(shop_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_shop        ON waitlist(shop_id);
CREATE INDEX IF NOT EXISTS idx_users_email          ON platform_users(email);

-- ─── Contact enquiries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  full_name      TEXT NOT NULL,
  shop_name      TEXT NOT NULL,
  shop_type      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT,
  message        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  onboarded_at   TEXT,
  shop_id        TEXT
);

CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);

-- ─── Invites ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email      TEXT NOT NULL,
  shop_id    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'admin',
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invites_token   ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_shop_id ON invites(shop_id);
