-- Provision the two FICTIONAL portfolio demo shops in a real environment.
-- Ids and slugs are the code-owned registry in packages/utils/src/portfolioDemo.ts.
-- The platform's create route always mints "<name>-<number>" slugs, so these two
-- rows are inserted directly, exactly as the showcase harness and E2E fixture do.
-- Everything an owner would enter (settings, services, team, portraits, style
-- notes) then goes through the API: node tools/showcase/provision.mjs
--
-- Run these with `wrangler d1 execute <db> --remote --command "<both statements>"`.
-- Not with --file: that uses D1's import API, which refuses an OAuth login
-- (Authentication error 10000, seen 2026-11-06) and takes the database offline
-- while it runs.
--
-- Plain INSERTs on purpose: a second run fails on the UNIQUE keys (id, slug,
-- shop_number, owner_email) and changes nothing. Owner emails use the reserved
-- .invalid domain and can never receive mail.
INSERT INTO shops (id, shop_number, slug, name, type, owner_email, status)
VALUES ('pp-demo-ferdyms-barber', 9001, 'ferdyms-barber-shop-demo', 'FerdyM''s Barber Shop', 'barber_shop', 'owner@ferdyms.demo.invalid', 'active');
INSERT INTO shops (id, shop_number, slug, name, type, owner_email, status)
VALUES ('pp-demo-linden-lark', 9002, 'linden-and-lark-demo', 'Linden & Lark Hair Studio', 'beauty_parlor', 'owner@lindenlark.demo.invalid', 'active');
