-- Mark contact enquiries after developer onboards a shop from the enquiry.
ALTER TABLE contacts ADD COLUMN onboarded_at TEXT;
ALTER TABLE contacts ADD COLUMN shop_id TEXT;
