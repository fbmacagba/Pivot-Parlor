# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Pivot Parlor is a barbershop and beauty salon SaaS platform. It is a Turborepo monorepo with two main applications:

- **`apps/web`** — Remix frontend running on Cloudflare Pages
- **`apps/worker`** — Hono API running on Cloudflare Workers

Supporting packages live in `packages/`. Additional Cloudflare Workers for background jobs (AI site generation, image processing, etc.) live in `apps/workers/`.

## Common Commands

### Development

```bash
# Start both web and worker in dev mode (from repo root)
npm run dev

# Start only the Remix frontend
cd apps/web && npm run dev

# Start only the Worker API
cd apps/worker && npm run dev
```

### Build & Type Check

```bash
# Build everything
npm run build

# Type-check everything
npm run check-types

# Type-check single app
cd apps/web && npx tsc
cd apps/worker && npx tsc --noEmit
```

### Lint & Format

```bash
npm run lint
npx prettier --write "**/*.{ts,tsx,md}"
```

### Tests

```bash
# Unit tests (vitest-pool-workers — real worker + simulated D1/KV)
npm test                       # all workspaces
cd apps/worker && npm test     # worker only

# E2E tests (Playwright). E2E_BASE_URL is REQUIRED (set it in .env) and must
# point at staging/preview — NEVER production. The config refuses to run
# without it; prod has E2E fixtures disabled.
npx playwright test
npx playwright test tests/e2e/booking.spec.ts
```

### Code graph (graphite)

A machine-wide graphite daemon keeps a fresh dependency graph of this repo in `graph-out/` (gitignored; rebuilt automatically within seconds of file changes). **Before any non-trivial or multi-file change, consult the graph instead of broad greps** — e.g. "who reads this column/function" is one `impact` call:

```bash
python -m graphite check .           # confirm the graph is fresh
python -m graphite context <file>    # what <file> depends on / what depends on it
python -m graphite impact <file>     # blast radius of changing <file>
python -m graphite query "stats"     # graph overview
```

Treat the output as a dependency map, not proof of correctness — still read the relevant sources and tests before editing. If `check` reports stale, rebuild with `python -m graphite -v build .`. Full workflow notes live in `AGENTS.md` (kept for non-Claude agents that read that file).

### Deployment

```bash
# Deploy Worker API (production; CI does this on push to main)
cd apps/worker && npx wrangler deploy

# Deploy Worker API (staging — separate D1/KV/R2/queues, E2E fixtures enabled)
cd apps/worker && npx wrangler deploy --env staging

# Deploy Frontend (Cloudflare Pages)
cd apps/web && npm run deploy
```

### Database migrations

Migrations are tracked in a `schema_migrations` table and applied by `scripts/migrate.mjs` (CI runs it on worker deploy). Never apply migration files by hand with `wrangler d1 execute`.

```bash
# Apply pending migrations
node scripts/migrate.mjs                  # local D1
node scripts/migrate.mjs --remote         # production
node scripts/migrate.mjs --remote --db pivot-parlor-db-staging   # staging

# Adopt an existing database ONCE (records history without executing):
node scripts/migrate.mjs --remote --baseline
```

**Adding a migration:** create `apps/worker/src/db/migrations/0NN_name.sql` (next number; currently up to `042`), also reflect the change in `schema.sql` (it is the rolling snapshot used as migration `000`), and run the worker test suite — it replays the full chain and fails if the migration is not replayable.

**Data migrations that reference columns they later drop** (like the WS-4 pence conversion) must start with a replay-guard directive so the chain stays replayable on databases built from the snapshot:

```sql
-- replay-guard: skip-if-column-absent <table>.<column>
```

When the named column is absent the whole file is recorded as applied without executing. Supported by `scripts/migrate.mjs` and both test `apply-schema.ts` files; guard on the column the file drops LAST.

## High-Level Architecture

### Request Flow

```
Browser → Cloudflare Pages (Remix) → Cloudflare Workers (Hono API) → Cloudflare D1 (SQLite)
                                      ↓
                               Cloudflare KV / R2 / Queues
```

The Remix frontend acts as a BFF (Backend-for-Frontend). It proxies authenticated requests to the Hono Worker using `createApiClient(env.API_URL, token)`. Some routes also proxy directly in loaders/actions using `fetch` with a Bearer token.

### Auth Flow

- JWT signed with `JWT_SECRET` (shared between Pages and Worker).
- Session stored in `pp_session` cookie (HttpOnly, Lax, 7-day expiry).
- Remix side verifies by calling `GET /auth/me` on the Worker rather than verifying locally.
- Worker middleware (`authMiddleware`) verifies the JWT from either `Authorization: Bearer` header or `pp_session` cookie.
- Roles: `developer`, `admin`, `staff`, `customer`. Developers bypass shop-scoped permission checks.

### API Conventions

- **Worker responses** always use `{ success: boolean, data?: T, error?: string }`.
- **Remix loaders/actions** should return `json({ success, data?, error? })` to match.
- **Shop-scoped queries** in the Worker must include `WHERE shop_id = ?`.
- **Money is INTEGER pence** (WS-4). DB money columns and API JSON money fields are named `*_pence`. Pounds exist only at two boundaries: form input (`parsePoundsToPence`) and display/AI presentation (`formatPence` / `price_gbp` in the site pipeline), all from `@repo/utils`. `calculateCommissionPence` is the single commission rounding path — never inline `* 0.1`. Never add `REAL` money columns.
- **SQL** must use prepared statements; never interpolate user input.

### Database

- Cloudflare D1 (SQLite): `pivot-parlor-db` (production), `pivot-parlor-db-staging` (staging).
- Schema snapshot in `apps/worker/src/db/schema.sql`; sequential migrations in `apps/worker/src/db/migrations/` (currently up to `042`), tracked in `schema_migrations` and applied via `scripts/migrate.mjs` (see Database migrations above).
- The main worker's migration chain is the **canonical schema owner** — including tables used by `apps/workers/*` (`bw_*`, `chat_sessions`, `ai_usage_log`, `shop_settings`). The background workers' `ensure-schema` files are **assert-only** (WS-8): they verify the shape and throw a named error when a migration is missing — they never execute DDL. All DDL goes in a migration.
- Query helpers in `apps/worker/src/db/queries.ts`. Add new helpers there, do not inline SQL.
- UUIDs are generated with `crypto.randomUUID()`.

### Key Worker Routes

| Route | Purpose |
|-------|---------|
| `/auth/*` | Login, register, OAuth (Google, Facebook, LinkedIn) |
| `/api/shops` | Developer shop CRUD |
| `/api/shops/:shopId/services` | Service management |
| `/api/shops/:shopId/staff` | Staff management |
| `/api/shops/:shopId/schedule` | Staff schedules |
| `/api/shops/:shopId/bookings` | Booking management |
| `/api/shops/:shopId/slots` | Public availability lookup |
| `/api/bookings` | Public booking creation |
| `/api/me` | Customer own-data (bookings) |
| `/api/walkin` | Walk-in queue |
| `/api/ai` | AI theme/site generation |
| `/api/webhooks/stripe` | Stripe webhooks (bypasses CORS/logger) |

### Remix Route Conventions

- Marketing pages: `_marketing._index.tsx`, `_marketing.about.tsx`, etc.
- Admin dashboard: `admin.tsx` (layout), `admin.services.tsx`, etc.
- Developer dashboard: `dev.tsx` (layout)
- Staff dashboard: `staff.tsx` (layout)
- Public shop sites: `$shopSlug.tsx` (layout), `$shopSlug._index.tsx`, `$shopSlug.book.tsx`, etc.
- API proxies: `api.shops.$shopId.delete.tsx`, `api.me.bookings.tsx`, etc.

## Critical Gotchas

### Route File Shadowing (Remix)

Remix route discovery treats `.js` files as higher priority than `.tsx` files. There are compiled `.js` twins alongside `.tsx` route files in `apps/web/app/routes/`. **If you modify a `.tsx` route but the matching `.js` file is stale, the old `.js` will be served instead.** Always remove or regenerate the `.js` twin after editing `.tsx` routes.

### Worker Dev Proxy Port

The Worker dev server runs on port `8787` (configured in `wrangler.toml`). The Remix Vite dev proxy expects this. If the Worker dev server is not running, Remix routes that proxy to the Worker will fail.

### Secrets

- **Pages secrets**: `npx wrangler pages secret put SECRET_NAME --project-name pivot-parlor-web`
- **Worker secrets**: `cd apps/worker && npx wrangler secret put SECRET_NAME`
- Do NOT use `wrangler secret put` (without `pages`) for the web project — it only works for Workers.

### Component & Design Conventions

- UI components live in `apps/web/app/components/ui/` (Button, Input, Dialog, Badge, Card).
- Fonts: Playfair Display (headings), DM Sans (body).
- Brand colors: gold `#C9A84C`, dark `#0D0D0D`. No blue in marketing chatbot or marketing pages.
- All dashboards use `DashboardLayout` + `Sidebar`.
- Do not use em-dashes in user-facing text.

### Shop ID Resolution for Developer Support

When a developer accesses an admin route, they do not have a fixed `shop_id`. The route must read `shopId` from the query string or form data:

```typescript
const shopId = user.role === "developer"
  ? new URL(request.url).searchParams.get("shopId")
  : user.shop_id;
```

### Stripe Webhook Isolation

Stripe webhook routes are mounted on a separate `Hono` app (`stripeWebhookApp`) that bypasses global CORS and logger middleware. This avoids edge cases where Stripe's lack of an `Origin` header causes redirects or non-JSON responses.

### AI / Background Workers

The `apps/workers/` directory contains standalone Cloudflare Workers for:
- `builder` — AI site generation
- `images` — Image processing
- `research` — Site research
- `chatbot` — Chatbot backend
- `audit` — Audit tasks
- `text` — Text processing
- `booking` — Booking-related background work

These are deployed independently and communicate via queues.
