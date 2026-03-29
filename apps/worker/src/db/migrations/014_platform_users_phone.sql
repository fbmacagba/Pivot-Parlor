-- Migration 014: add phone column to platform_users for customer profile
ALTER TABLE platform_users ADD COLUMN phone TEXT;
