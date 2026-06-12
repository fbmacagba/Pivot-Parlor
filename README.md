# Pivot Parlor

**Booking and business platform for barbershops and beauty salons.** Every shop gets its own AI-generated, fully branded booking site — no client accounts required, no monthly fees, 10% commission on completed bookings only.

> 📄 Product requirements: [docs/PRD.md](docs/PRD.md) · Business strategy: [docs/STRATEGY.md](docs/STRATEGY.md) · Dashboard spec: [docs/DASHBOARD_SPEC.md](docs/DASHBOARD_SPEC.md) · Agent guidance: [CLAUDE.md](CLAUDE.md)

---

## What it does

- **AI-generated branded shop sites** — each shop gets a public site at `pivotparlor.com/<shopSlug>` with AI-generated theme, copy, and imagery.
- **Frictionless online booking** — customers book with name + contact details; no platform account needed.
- **Shop management** — services, staff, schedules, bookings, walk-in queue, waitlist, revenue analytics.
- **Payments** — Stripe Connect; the platform takes 10% commission on completed bookings.
- **Multi-tenant** — one platform, many shops, strict shop-scoped data isolation.
- **Roles** — `developer` (platform operator), `admin` (shop owner), `staff`, `customer`.

## Architecture

```
Browser
  └─► Cloudflare Pages — Remix frontend (apps/web), acts as BFF
        └─► Cloudflare Workers — Hono API (apps/worker)
              ├─► Cloudflare D1 (SQLite) — pivot-parlor-db
              ├─► Cloudflare KV — sessions, caches, rate data
              ├─► Cloudflare R2 — images/assets
              └─► Cloudflare Queues — reminders, background jobs
                    └─► Background workers (apps/workers/*)
```

- **Auth**: JWT (HS256, shared `JWT_SECRET`) in the `pp_session` HttpOnly cookie or `Authorization: Bearer` header. The Remix BFF verifies sessions by calling `GET /auth/me` on the Worker.
- **API convention**: Worker responses are always `{ success: boolean, data?: T, error?: string }`.
- **Tenanting**: every shop-scoped query must filter by `shop_id`; SQL is always parameterized via prepared statements.

## Repository layout

```
apps/
  web/        Remix frontend on Cloudflare Pages (BFF — proxies to the Worker API)
  worker/     Hono API on Cloudflare Workers (auth, shops, bookings, payments, AI)
  workers/    Standalone background Workers, deployed independently:
              builder (AI site gen), images, research, chatbot, audit, text, booking
  docs/       Internal docs app
packages/
  types/      Shared TypeScript types (@repo/types)
  utils/      Shared utilities (@repo/utils)
  ui/         Shared React components (@repo/ui)
  eslint-config/, typescript-config/
tests/e2e/    Playwright end-to-end tests
scripts/      Operational scripts (live verification, dev password reset)
docs/         Product & strategy documentation
```

## Getting started

### Prerequisites

- Node.js ≥ 18 (repo pins npm 11)
- A Cloudflare account with access to the project's Pages/Workers/D1/KV/R2 resources
- Wrangler authenticated: `npx wrangler login`

### Install & run

```bash
npm install

# Start web (Remix) + worker (Hono) together
npm run dev

# Or individually
cd apps/web && npm run dev      # Remix on Vite
cd apps/worker && npm run dev   # Worker API on port 8787
```

> ⚠️ The Remix dev proxy expects the Worker API on port **8787**. Routes that proxy to the Worker fail if it isn't running.

### Environment

Local configuration lives in `.env` (gitignored — never commit it). Keys used:

| Key | Purpose |
|-----|---------|
| `JWT_SECRET` | JWT signing secret (must match the deployed Worker secret) |
| `DEV_PASSWORD` | Local developer account password |
| `E2E_BASE_URL` | Target for Playwright tests |

Production secrets are managed with Wrangler, never in files:

```bash
# Worker secrets
cd apps/worker && npx wrangler secret put SECRET_NAME

# Pages secrets (note: requires the `pages` subcommand)
npx wrangler pages secret put SECRET_NAME --project-name pivot-parlor-web
```

## Common commands

```bash
npm run build          # Build everything (Turborepo)
npm run check-types    # Type-check all workspaces
npm run lint           # Lint all workspaces
npm run format         # Prettier

npx playwright test                          # E2E suite (set E2E_BASE_URL — do not run against prod)
npx playwright test tests/e2e/booking.spec.ts # Single E2E file

npm run verify:live    # Post-deploy smoke check
```

## Database

- Cloudflare D1 (SQLite), database `pivot-parlor-db`.
- Base schema: [apps/worker/src/db/schema.sql](apps/worker/src/db/schema.sql)
- Sequential migrations: [apps/worker/src/db/migrations/](apps/worker/src/db/migrations/)
- Query helpers live in [apps/worker/src/db/queries.ts](apps/worker/src/db/queries.ts) — add helpers there, don't inline SQL in routes.

```bash
# Apply a migration to the remote DB
npx wrangler d1 execute pivot-parlor-db --remote --file=apps/worker/src/db/migrations/NNN_name.sql
```

## Deployment

```bash
# Worker API
cd apps/worker && npx wrangler deploy

# Frontend (Cloudflare Pages)
cd apps/web && npm run deploy
```

GitHub Actions workflows in [.github/workflows/](.github/workflows/) deploy `web` and `worker` on push. Background workers in `apps/workers/*` are deployed individually with `wrangler deploy` from each directory.

## Known footguns

- **`.js` twins shadow `.tsx` routes.** Compiled `.js` files next to `.tsx` files in `apps/web/app/` take priority in Remix route discovery. After editing a `.tsx` route, remove its stale `.js` twin or your change won't be served. (They are gitignored, but exist locally.)
- **E2E tests default to production** unless `E2E_BASE_URL` is set. Always point them at a non-production target.
- **Stripe webhooks** are mounted on an isolated Hono app that bypasses CORS/logger middleware — don't fold them into the main app.

## Documentation

| Document | Contents |
|----------|----------|
| [docs/PRD.md](docs/PRD.md) | Product requirements: users, features, roadmap, non-functional requirements |
| [docs/STRATEGY.md](docs/STRATEGY.md) | Market analysis, competitive positioning, pricing, go-to-market |
| [docs/DASHBOARD_SPEC.md](docs/DASHBOARD_SPEC.md) | Dashboard UX specification |
| [CLAUDE.md](CLAUDE.md) | Conventions and gotchas for AI-assisted development |
