# Runbook: Secret Rotation

Production secrets live only in Wrangler secrets (Worker + Pages). Local `.env` is gitignored and holds dev values only. Rotate immediately if a secret is exposed, and on a regular cadence otherwise.

## JWT_SECRET

⚠️ **Impact: rotating logs out every active session** (all JWTs become invalid). Do it at low-traffic hours.

1. Generate a new 256-bit secret:
   ```bash
   openssl rand -hex 32
   # PowerShell alternative:
   # -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
   ```
2. Set it on the Worker API:
   ```bash
   cd apps/worker
   npx wrangler secret put JWT_SECRET
   ```
3. Set the same value on the Pages project (the BFF shares it):
   ```bash
   npx wrangler pages secret put JWT_SECRET --project-name pivot-parlor-web
   ```
   (Note: must be the `pages` subcommand — plain `wrangler secret put` only targets Workers.)
4. Update your local `.env`.
5. Verify: log in on production, confirm a fresh session works; old sessions must be rejected.
6. Run the smoke check: `npm run verify:live`.

The Worker and Pages must be updated together — if they disagree, all authenticated traffic fails.

## DEV_PASSWORD (developer account)

1. Choose a strong random password; update `DEV_PASSWORD` in local `.env`.
2. Emit the upsert SQL:
   ```bash
   node scripts/reset-dev-password.mjs
   ```
3. Apply it to production D1 (command is printed by the script):
   ```bash
   cd apps/worker
   npx wrangler d1 execute pivot-parlor-db --remote --command "<paste SQL>"
   ```
4. Verify login as `dev@pivotparlor.com` with the new password.

There is **no first-login bootstrap** for the developer account (removed 2026-06 — it was an account-takeover vector). A fresh database must be seeded with this script before the developer can log in.

## OAuth / Stripe / AI provider keys

Rotate at the provider, then:
```bash
cd apps/worker
npx wrangler secret put STRIPE_SECRET_KEY          # etc.
```
Names in use are listed as comments in `apps/worker/wrangler.toml`.

## Rotation log

| Date | Secret | Reason | By |
|------|--------|--------|-----|
| 2026-06-14 | JWT_SECRET | T0.2 precautionary rotation. Fresh random set on Worker + Pages (production) via Wrangler **only** — deliberately NOT written to `.env` (re-copying the prod value into plaintext would defeat the rotation). Local `.env`/`.dev.vars` got a **separate** dev-only value. Verified: pre-rotation token → 401, fresh login → 200. | Claude |
| _pending_ | DEV_PASSWORD | T0.2 precautionary rotation. Awaiting the operator's chosen password, then `reset-dev-password.mjs` → apply UPSERT to prod D1 → verify login. | — |

> Note on step 4 ("Update your local `.env`") above: prefer giving local dev a **distinct** JWT_SECRET rather than copying the prod value into a plaintext file. The Worker and Pages **production** secrets must match each other; local dev does not need to match prod.
