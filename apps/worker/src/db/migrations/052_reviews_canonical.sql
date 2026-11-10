-- Migration 052: rebuild reviews to the shape the chain defines.
--
-- Production's reviews predates migration 009 (baselined there, never run),
-- so it kept its original definition (read from sqlite_master in the D1
-- console, 2026-11-10). Its shop_id has only
--   FOREIGN KEY (shop_id) REFERENCES shops(id)
-- with no ON DELETE CASCADE, where the chain (009 + 013) cascades. Deleting a
-- shop that has a review was therefore refused in production with
-- "FOREIGN KEY constraint failed", after the developer delete route had
-- already removed that shop's settings, generation jobs and cached site.
--
-- SQLite cannot change a foreign key in place, so the table is rebuilt to
-- 009 + 013's exact columns: create, copy every row, drop, rename, then
-- recreate both indexes (DROP TABLE drops them). On a database built from
-- the chain this changes nothing but the stored definition text.
--
-- Production's other differences go with the rebuild:
--   - id gains its default (the route always supplies one);
--   - rating becomes the chain's REAL with no CHECK (the route already
--     refuses anything but a whole number from 1 to 5);
--   - idx_reviews_shop_id gives way to the chain's idx_reviews_shop_created.
--
-- scripts/migrate.mjs runs a file statement by statement, NOT atomically:
--   - fails at the CREATE or the copy: the old table is untouched (drop
--     reviews_new, then re-run). Foreign keys are enforced, so no review can
--     point at a missing shop or booking; if one ever did, the copy stops
--     here rather than dropping it silently.
--   - fails at the RENAME: the rows are in reviews_new (rename it by hand,
--     then run both CREATE INDEX statements).
--   - fails at an index: run the remaining CREATE INDEX statement(s) by hand.
-- The pre-run Time Travel bookmark covers every step. Between the DROP and
-- the RENAME a review submission fails and the public list reads empty, for
-- the few seconds the file takes.

CREATE TABLE reviews_new (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id       TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  rating        REAL NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  booking_id    TEXT REFERENCES bookings(id)
);

INSERT INTO reviews_new (id, shop_id, customer_name, rating, body, created_at, booking_id)
SELECT id, shop_id, customer_name, rating, body, created_at, booking_id
FROM reviews;

DROP TABLE reviews;

ALTER TABLE reviews_new RENAME TO reviews;

CREATE UNIQUE INDEX idx_reviews_booking_id ON reviews(booking_id) WHERE booking_id IS NOT NULL;

CREATE INDEX idx_reviews_shop_created ON reviews(shop_id, created_at DESC);
