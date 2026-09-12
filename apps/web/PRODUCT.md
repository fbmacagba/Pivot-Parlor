# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences carry equal weight when design decisions trade off (confirmed 2026-09-12):

- **Customers of a shop**, on that shop's own branded site at `pivotparlor.com/<shopSlug>`, usually on a phone, often in the moment they decide they want a haircut or treatment. Their job is to book (or join the walk-in queue) in under a minute, as a guest, with no platform account and no app download.
- **Shop owners and managers** of independent barbershops and beauty salons, in the admin dashboard between clients or after hours. Their job is to run the business: services, staff, schedules, bookings, walk-ins, waitlist, deposits, point of sale, stock and revenue.

Secondary audiences:

- **Staff** (barbers, stylists, therapists) in the staff dashboard: their own day, their own bookings.
- **The platform operator** (the developer) in the developer dashboard: invitation-only onboarding, AI site generation, AI Deploy, support across shops.

Customers never create a platform account. Shops are onboarded by the operator, not by self-serve signup.

## Product Purpose

Pivot Parlor is a multi-tenant booking and business platform for independent barbershops and beauty salons in the UK. Every shop gets its own AI-generated, fully branded booking website (theme, copy, logo, hero and per-service imagery generated for that shop) backed by a complete back office: online booking with optional deposits, walk-in queue, waitlist, staff scheduling, reminders, point of sale, inventory, and revenue reporting. A per-shop AI assistant on each site answers from that shop's live services, staff, hours and promotions and drives toward a booking.

It exists to remove three industry failures documented in `docs/STRATEGY.md`: booking friction (account walls), no brand ownership (shops listed inside a marketplace's brand), and opaque pricing (monthly fees, hidden commissions, per-message charges, contracts).

Success is a shop earning more through its own site: more completed bookings, fewer no-shows, and a customer relationship the shop owns. Platform revenue follows shop revenue: a one-time £100 setup fee, no monthly fee, and 10% commission on completed bookings only (refunded deposits are never charged).

## Positioning

Lead claim (confirmed 2026-09-12): **the shop owns its brand and its site.** Every shop gets its own AI-built branded site, not a listing inside someone else's marketplace. Fresha, Booksy and Treatwell cannot truthfully make this claim: they put the shop inside the platform's brand on a generic page.

Supporting claims, always subordinate to the lead: pay only when a booking completes (no accounts, no monthly fees, no contracts), and the whole site plus its chatbot are generated from a short onboarding and kept in sync with live data.

Pivot Parlor is not a consumer discovery marketplace. Shops bring their own audience; the platform never competes with them for it.

## Operating Context

- Shops are UK businesses; money is GBP and the platform is UK-first for compliance (UK GDPR, PECR cookie consent and marketing opt-in).
- Customers arrive from the shop's own channels (social, word of mouth, a link in the window) and book on their phone. The site is installable as a PWA; there are no native apps.
- Owners and staff use the dashboards on phones and laptops in a busy shop: short sessions, interruptions, one-handed use are normal.
- The operator onboards each shop by invitation, runs the AI generation pipeline (research, copy, theme, images, chatbot) and chooses which LLM models power it from the developer dashboard.
- Payments run through Stripe Connect. Deposits can be taken at booking; no-shows and late cancellations may keep the deposit, and commission then applies only to what the shop keeps.
- The chatbot answers pricing questions from real data only; it never invents services, prices or availability.

## Capabilities and Constraints

Confirmed capabilities (see `README.md` and `docs/PRD.md` for detail):

- Public shop sites with AI-generated theme, copy and imagery; guest booking with name and contact details; optional deposits.
- Shop management: services, staff, schedules, bookings, walk-in queue, waitlist, reminders, revenue analytics.
- Point of sale and inventory: in-store sales, retail products and stock, purchasing, stock-takes, back-bar consumption, per-line returns with Stripe refunds.
- Per-shop AI booking assistant grounded in live shop data.
- Roles: developer, admin, staff, customer. Developers can act on any shop; shop-scoped data is always filtered by shop.

Constraints and terminology:

- "Shop" is the tenant. A shop has services, staff, bookings, walk-ins, a waitlist and a public site. "Developer" means the platform operator, not an engineer using the API.
- Money is stored and transported as integer pence; pounds appear only in forms and display.
- Onboarding is invitation-only; there is no self-serve signup and no marketplace listing.
- Barber and beauty verticals only; no fitness, spa or enterprise features.
- Native mobile apps are out of scope; the PWA is the mobile experience.
- User-facing text does not use em-dashes.

Explicitly undecided: none recorded at init. Roadmap phases (AI receptionist, smart scheduling, dynamic pricing) live in `docs/STRATEGY.md` and are not commitments.

## Brand Commitments

- Name: **Pivot Parlor**. Domain `pivotparlor.com`; shop sites live at `pivotparlor.com/<shopSlug>`.
- Committed identity constraints recorded in `CLAUDE.md` (binding, not to be expanded here): headings in Playfair Display, body in DM Sans; brand gold `#C9A84C` on dark `#0D0D0D`; no blue on marketing pages or in the marketing chatbot.
- Each shop's public site carries the shop's own brand, generated per shop; the platform brand appears on marketing, onboarding and dashboard surfaces, not on customers' booking pages.
- Voice on marketing surfaces today: plain, confident, concrete about pricing ("£100 setup. No monthly fees. Live in 24 hours.").

## Evidence on Hand

Pre-launch (confirmed 2026-09-12). No live shops, customer testimonials, case studies, press or platform metrics exist. Future work must not fabricate any of these, nor name example shops as if they were real.

Citable figures are industry statistics from `docs/STRATEGY.md` only: 71% of clients have abandoned a booking because it was too hard; no-shows cost a median barbershop about $5,800 a year. Cite them as industry figures, never as Pivot Parlor results.

Real assets: logo and app icons in `apps/web/public/` (`favicon.svg`, `apple-touch-icon.png`, `icons/`, `site.webmanifest`); legal pages (terms, privacy, cookies, data processing agreement) under `apps/web/app/routes/_marketing.*.tsx`; the company is registered in England and Wales. Pricing facts: £100 one-time setup, £0 monthly, 10% per completed booking.

## Product Principles

1. **The shop is the brand.** Every customer-facing surface belongs to the shop; the platform stays out of the customer's way and out of the shop's frame.
2. **Booking beats browsing.** A customer should reach a confirmed booking in one short flow with nothing to sign up for; anything that delays that is a cost.
3. **Owner time is scarce.** Back-office surfaces favour scanability, fast repeat actions and phone-sized layouts over expression.
4. **Only earn when the shop earns.** Pricing, deposits and commission are stated plainly wherever they appear; nothing is hidden in a flow.
5. **Real data or nothing.** Sites, chatbots and dashboards speak from live shop data; no invented content, prices, reviews or availability anywhere.
