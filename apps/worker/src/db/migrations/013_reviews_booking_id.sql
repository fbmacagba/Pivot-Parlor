-- Migration 013: add booking_id to reviews for dedup + verification
ALTER TABLE reviews ADD COLUMN booking_id TEXT REFERENCES bookings(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking_id ON reviews(booking_id) WHERE booking_id IS NOT NULL;
