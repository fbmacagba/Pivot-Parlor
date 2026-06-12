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
# E2E tests (Playwright). Tests run against https://pivotparlor.com by default.
npx playwright test

# Run a single E2E test file
npx playwright test tests/e2e/booking.spec.ts
```

### Deployment

```bash
# Deploy Worker API
cd apps/worker && npx wrangler deploy

# Deploy Frontend (Cloudflare Pages)
cd apps/web && npm run deploy
```

### Database

```bash
# Run a D1 migration (from repo root)
npx wrangler d1 execute pivot-parlor-db --remote --file=apps/worker/src/db/migrations/NNN_name.sql
```

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
- **SQL** must use prepared statements; never interpolate user input.

### Database

- Cloudflare D1 (SQLite) named `pivot-parlor-db`.
- Schema in `apps/worker/src/db/schema.sql`.
- Query helpers in `apps/worker/src/db/queries.ts`. Add new helpers there, do not inline SQL.
- Migrations are sequential SQL files in `apps/worker/src/db/migrations/` (currently up to `011`).
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
