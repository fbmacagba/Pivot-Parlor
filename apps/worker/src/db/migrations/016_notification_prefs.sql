-- Migration 016: notification preferences on shop_settings
ALTER TABLE shop_settings ADD COLUMN booking_confirmation_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shop_settings ADD COLUMN booking_reminder_email INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shop_settings ADD COLUMN reminder_hours_before INTEGER NOT NULL DEFAULT 24;
ALTER TABLE shop_settings ADD COLUMN review_request_email INTEGER NOT NULL DEFAULT 1;
