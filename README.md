# Pivot Parlor

**Booking and business platform for barbershops and beauty salons.** Every shop gets its own AI-generated, fully branded booking site — no client accounts required, no monthly fees, 10% commission on completed bookings only.

> 📄 Product requirements: [docs/PRD.md](docs/PRD.md) · Business strategy: [docs/STRATEGY.md](docs/STRATEGY.md) · Dashboard spec: [docs/DASHBOARD_SPEC.md](docs/DASHBOARD_SPEC.md) · Agent guidance: [CLAUDE.md](CLAUDE.md)

---

## What it is

Pivot Parlor is a multi-tenant SaaS booking and business platform for independent barbershops and beauty salons. Every shop is onboarded by the platform operator and receives its **own AI-generated, fully branded booking website** at `pivotparlor.com/<shopSlug>` — theme, copy, logo, hero image, and per-service photography all generated specifically for that shop — backed by a complete booking, staff, walk-in, and revenue back office. Customers book as guests; no platform account is ever required.

## Why it exists

Independent shops lose revenue to three industry-wide failures (full analysis in [docs/STRATEGY.md](docs/STRATEGY.md)):

1. **Booking friction.** 71% of clients have abandoned a booking because it was too hard, and most platforms force the client to create an account before they can book.
2. **No brand ownership.** Marketplace competitors (Fresha, Booksy, Treatwell) put the shop inside the _platform's_ brand on a generic page — the shop never builds its own digital presence or owns the customer relationship.
3. **Opaque, punishing pricing.** Monthly fees, hidden marketplace commissions, per-message charges, client-side booking fees, and 12-month contracts erode trust and margin — while no-shows alone cost a median barbershop ~$5,800/year.

Pivot Parlor was built to remove all three: a branded site the shop _owns_, zero-friction guest booking, and pricing that charges the shop only when it actually earns.

## What it does

- **AI-generated branded shop sites** — each shop gets a public site at `pivotparlor.com/<shopSlug>` with AI-generated theme, copy, and imagery.
- **Frictionless online booking** — customers book with name + contact details; no platform account needed. Optional deposits are collected at booking via Stripe.
- **Shop management** — services, staff, schedules, bookings, walk-in queue, waitlist, and revenue analytics.
- **Point-of-sale & inventory** — in-store POS sales, retail products and stock levels, purchasing, stock-takes, back-bar consumption (bill of materials), and per-line returns with API-initiated Stripe refunds.
- **Per-shop AI assistant** — every site has a booking chatbot grounded in that shop's live services, staff, hours, and promotions; it answers pricing questions from real data only and drives toward a booking.
- **Payments** — Stripe Connect; the platform takes 10% commission on completed bookings.
- **Legal & compliance** — per-shop and platform privacy, cookie, and terms pages, a UK GDPR Article 28 Data Processing Agreement at `/dpa`, and recorded acceptance of the terms at onboarding.
- **Multi-tenant** — one platform, many shops, strict shop-scoped data isolation.
- **Roles** — `developer` (platform operator), `admin` (shop owner), `staff`, `customer`.

## What makes it different

Most competitors are _marketplaces_ that rent shops a generic page and monetise through monthly fees and opaque commissions. Pivot Parlor inverts that:

|                           | Typical marketplace platforms                                                            | Pivot Parlor                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Shop's web presence**   | Generic page in the platform's brand                                                     | The shop's **own** AI-generated, fully branded site at `pivotparlor.com/<shop>`                           |
| **Customer booking**      | Client must create a platform account                                                    | Guest booking — name + contact only, no account, no app                                                   |
| **Pricing model**         | $15–250/mo + opaque marketplace commission + client-side fees; often a 12-month contract | £100 one-time setup + 10% on _completed_ bookings only — no monthly fee, no client-side fees, no contract |
| **When the shop pays**    | Regardless of whether it earned                                                          | Only when a booking completes (shop earns £0 → pays £0)                                                   |
| **Site creation**         | Manual page setup                                                                        | An AI pipeline generates theme, copy, imagery, and legal pages per shop                                   |
| **Customer relationship** | Owned by the marketplace                                                                 | Owned by the shop                                                                                         |
| **Infrastructure**        | —                                                                                        | Runs entirely on the Cloudflare edge (Pages / Workers / D1 / KV / R2 / Queues) at near-zero marginal cost |

## How it responds to financial queries

Money questions are answered from **real, shop-specific data — never invented**:

- **Customer pricing questions (per-shop chatbot).** When a visitor asks "how much is a …?" or about cost, the shop's AI assistant answers using only that shop's configured service and product prices (read live from the database, in £) plus any **active promotion** (discount % + code). Its system prompt explicitly forbids inventing prices or services it cannot see, separates bookable treatments from in-store retail products (products are sold in-store, not booked), and routes the visitor to the booking link. See [apps/workers/chatbot/src/prompt.ts](apps/workers/chatbot/src/prompt.ts).
- **Platform pricing is transparent and fixed.** What Pivot Parlor charges a shop is published and unconditional: £100 one-time setup + 10% commission on completed bookings, with no monthly fee and no client-side charges. When asked how the site was built or what the platform costs, the assistant links to [pivotparlor.com](https://pivotparlor.com) rather than quoting figures it shouldn't.
- **Shop revenue reporting.** Shop owners (`admin`) see their own revenue and commission analytics in the dashboard. All financial data is strictly shop-scoped by `shop_id`, so one shop can never see another's numbers; payments and commission settle through Stripe Connect.

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
- **Money**: all monetary values are stored and transported as integer pence (`*_pence` columns and API fields); pounds appear only at the input (`parsePoundsToPence`) and display (`formatPence`) boundaries. No `REAL` money columns.

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

| Key            | Purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `JWT_SECRET`   | JWT signing secret (must match the deployed Worker secret) |
| `DEV_PASSWORD` | Local developer account password                           |
| `E2E_BASE_URL` | Target for Playwright tests                                |

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

Migrations are tracked (`schema_migrations`) and applied by [scripts/migrate.mjs](scripts/migrate.mjs) — CI runs it on every worker deploy:

```bash
node scripts/migrate.mjs                # local D1
node scripts/migrate.mjs --remote       # production
node scripts/migrate.mjs --remote --db pivot-parlor-db-staging  # staging
node scripts/migrate.mjs --remote --baseline  # one-time adoption of an existing DB
```

## Deployment

```bash
# Worker API (production — CI also deploys on push to main)
cd apps/worker && npx wrangler deploy

# Worker API (staging — separate D1/KV/R2/queues, E2E fixtures enabled)
cd apps/worker && npx wrangler deploy --env staging
# → https://pivot-parlor-api-staging.bmorris0565.workers.dev

# Frontend (Cloudflare Pages)
cd apps/web && npm run deploy
```

End-to-end tests run in CI via [.github/workflows/e2e.yml](.github/workflows/e2e.yml): on every pull request it deploys the PR's worker and frontend to staging (running the staging D1 migrations first), then runs Playwright against the staging preview. A fast **smoke** tier (dev-login + public booking) runs on every PR; the **full** suite runs when the PR carries the `e2e` label or via manual dispatch.

GitHub Actions workflows in [.github/workflows/](.github/workflows/) deploy `web` and `worker` on push to `main`. Background workers in `apps/workers/*` are deployed individually with `wrangler deploy` from each directory.

## Known footguns

- **`.js` twins shadow `.tsx` routes.** Compiled `.js` files next to `.tsx` files in `apps/web/app/` take priority in Remix route discovery. After editing a `.tsx` route, remove its stale `.js` twin or your change won't be served. (They are gitignored, but exist locally.)
- **E2E tests default to production** unless `E2E_BASE_URL` is set. Always point them at a non-production target.
- **Stripe webhooks** are mounted on an isolated Hono app that bypasses CORS/logger middleware — don't fold them into the main app.

## Documentation

| Document                                         | Contents                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| [docs/PRD.md](docs/PRD.md)                       | Product requirements: users, features, roadmap, non-functional requirements |
| [docs/STRATEGY.md](docs/STRATEGY.md)             | Market analysis, competitive positioning, pricing, go-to-market             |
| [docs/DASHBOARD_SPEC.md](docs/DASHBOARD_SPEC.md) | Dashboard UX specification                                                  |
| [CLAUDE.md](CLAUDE.md)                           | Conventions and gotchas for AI-assisted development                         |
