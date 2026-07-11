-- 037: WS-7 / SEC-3 — email ownership verification.
-- platform_users.email_verified gates the email-matched customer surface
-- (/api/me bookings + cancel), closing the booking-history-by-email-claim
-- vector: password self-registration proves nothing about address ownership.
-- Backfills mark verified the accounts whose address IS proven:
--   * OAuth-linked users — the provider verified the address (oauth.ts rejects
--     unverified provider emails).
--   * Users created from a used invite — they received the invite by email.
--   * Non-customer roles — provisioned by developer/admin flows, never public
--     self-registration (SEC-1 boundary), so the operator vouches for them.
-- Existing password-registered customers stay unverified and go through the
-- verify-email flow.
ALTER TABLE platform_users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE platform_users SET email_verified = 1 WHERE id IN (SELECT user_id FROM oauth_accounts);

UPDATE platform_users SET email_verified = 1 WHERE role != 'customer';

UPDATE platform_users SET email_verified = 1
WHERE email IN (SELECT email FROM invites WHERE used_at IS NOT NULL);
