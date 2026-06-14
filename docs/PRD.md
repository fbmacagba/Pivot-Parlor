# Pivot Parlor — Product Requirements Document

**Status:** Living document
**Last updated:** 2026-06-12
**Related docs:** [STRATEGY.md](STRATEGY.md) (market & pricing rationale) · [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) (dashboard UX) · [README.md](../README.md) (technical setup)

---

## 1. Overview

Pivot Parlor is a SaaS booking and business platform for barbershops and beauty salons. Unlike marketplace platforms (Fresha, Booksy, Treatwell) that put shops inside the platform's brand, Pivot Parlor gives every shop its **own AI-generated branded website** with frictionless booking — customers never create a platform account.

**Positioning statement:**

> Pivot Parlor is the only booking platform that gives every beauty parlour and barber shop their own fully AI-branded online presence — with zero monthly fees, zero client-side charges, and white-glove onboarding — while charging only when the shop earns.

## 2. Problem

Independent barbershops and salons lose revenue to three industry-wide failures (see [STRATEGY.md §3](STRATEGY.md)):

1. **Booking friction.** 71% of clients have abandoned a booking because it was too hard; most platforms force clients to create accounts.
2. **No brand ownership.** Competitors give shops a generic page in the *platform's* brand; the shop never builds its own digital presence or owns its customer relationship.
3. **Opaque, punishing pricing.** Hidden commissions, per-message fees, client-side booking charges, and 12-month contracts erode trust and margins. No-shows alone cost a median barbershop ~$5,800/year.

## 3. Goals & non-goals

### Goals

- G1. Give every shop a branded, AI-generated public website with integrated booking.
- G2. Zero-friction customer booking: no account, no app download, no client-side fees.
- G3. Align platform revenue with shop revenue: £100 one-time setup + 10% commission on completed bookings; no monthly fee for the core product.
- G4. Unify online appointments and walk-in queue management in one calendar.
- G5. White-glove, invitation-only onboarding operated by the platform developer.
- G6. UK-first compliance: GDPR, PECR (cookie consent, marketing opt-in).
- G7. Operate at near-zero marginal infrastructure cost (Cloudflare edge stack).

### Non-goals (current scope)

- A consumer marketplace/discovery destination (shops bring their own audience).
- Native mobile apps (PWA planned in Phase 4 instead).
- Self-serve signup (onboarding is deliberately invitation-only).
- Fitness/spa/enterprise verticals (barber & beauty only).
- Inventory/POS hardware (Phase 2+ consideration).

## 4. Users & roles

| Role | Who | Can do |
|------|-----|--------|
| `developer` | Platform operator | Everything: shop CRUD, AI site generation, all shops' data, enquiries, platform settings. Bypasses shop-scoped permission checks. |
| `admin` | Shop owner/manager | Manage **their shop only**: services, staff, schedules, bookings, walk-ins, waitlist, settings, revenue. |
| `staff` | Barber/stylist | View their own schedule and bookings; manage their walk-in queue participation. |
| `customer` | End client | Book/cancel appointments, view own booking history, join waitlist/queue. Account optional — booking works as guest. |

**Hard requirement:** all shop-scoped reads and writes must verify the target resource belongs to the caller's shop (`shop_id` scoping). Cross-shop access is a security defect, not a feature gap.

## 5. Business model

- **£100 one-time setup fee** — covers white-glove onboarding + AI site generation.
- **10% commission** on completed bookings (Stripe Connect). Shop earns £0 → pays £0.
- **No monthly fee** for the core platform; future optional add-on tiers (Growth +£29/mo, AI Pro +£59/mo) amplify but never gate core booking functionality.
- Planned: commission cap (~£500/location/month) to protect high-volume shops.

Full pricing rationale and competitor comparison: [STRATEGY.md §6](STRATEGY.md).

## 6. Current product (Phase 1 — shipped)

### 6.1 Public shop sites
- AI-generated branded site per shop at `pivotparlor.com/<shopSlug>` (theme, copy, imagery) with selectable templates (Classic, Vibrant, Luxury, Editorial, Fresh, Minimal).
- Pages: home, booking, services, waitlist, legal (GDPR/PECR pages, cookie consent).

### 6.2 Booking
- Guest booking: service + staff + slot selection; name/email/phone — no account required.
- Slot availability computed from staff schedules minus existing bookings.
- Booking confirmation email and pre-appointment reminder (queue + cron driven).
- Customer self-service cancellation.
- **Integrity requirement:** a staff member's time slot can be booked exactly once. Concurrent requests for the same slot must not both succeed (enforced at the database level, not only by pre-check).

### 6.3 Shop administration
- Dashboards per role (`admin`, `staff`, `developer`) with services CRUD, staff CRUD + invitations, weekly schedule editor, bookings calendar/list with status flow (`pending → confirmed → completed / cancelled / no_show`), walk-in queue, waitlist, revenue analytics, shop settings (incl. notification preferences, Google Business URL).

### 6.4 Platform (developer) tooling
- Shop CRUD, AI theme/site generation and comparison, AI model selection, enquiry management (contact form leads), invite issuance.

### 6.5 Payments
- Stripe Connect onboarding per shop; 10% application fee on bookings; webhook-driven payment state (isolated webhook app, signature-verified).

### 6.6 Auth
- Email/password (PBKDF2-SHA256, 100k iterations) and OAuth (Google, Facebook, LinkedIn).
- JWT sessions (HS256, 7-day expiry) in HttpOnly/Secure/Lax cookie.
- **Requirement:** logout and credential revocation must take effect immediately (server-side session invalidation, not just JWT expiry).

## 7. Roadmap (summary — details in [STRATEGY.md §5](STRATEGY.md))

| Phase | Theme | Headlines |
|-------|-------|-----------|
| **2** | Competitive parity + differentiators | Reschedule-by-link, embeddable booking widget, Google Reserve, QR walk-in queue with SMS, deposits & no-show fees, client CRM/segments, POS & tips, marketing campaigns (email/SMS, PECR opt-in), referrals, review automation |
| **3** | AI domination layer | AI receptionist (WhatsApp + phone), smart scheduling & no-show risk scoring, dynamic pricing suggestions, AI content engine, revenue forecasting |
| **4** | Ecosystem & retention | Loyalty programme, customer PWA, multi-location support, staff marketplace/profiles, integrations (Google Calendar, Instagram booking, Xero/QuickBooks, Mailchimp) |

## 8. System architecture (reference)

Remix BFF on Cloudflare Pages → Hono API on Cloudflare Workers → D1 (SQLite) + KV + R2 + Queues, with independent background Workers (site builder, images, research, chatbot, audit, text, booking). See [README.md](../README.md) for the full diagram and conventions.

## 9. Non-functional requirements

These are product requirements, not implementation suggestions. Several are currently **not met** — see [the remediation task list](superpowers/plans/2026-06-12-remediation-task-list.md).

### 9.1 Security
- **NFR-S1 Tenant isolation:** no endpoint may return or mutate data outside the caller's shop scope (except `developer`).
- **NFR-S2 Session revocation:** logout invalidates the session server-side immediately.
- **NFR-S3 No privileged bootstrap paths** in production code (no first-login account claiming, no hardcoded test backdoors reachable in prod).
- **NFR-S4 Abuse resistance:** rate limiting on authentication, AI generation, and public form endpoints.
- **NFR-S5 OAuth safety:** CSRF-resistant state (nonce + expiry), redirect targets restricted to same-origin relative paths.
- **NFR-S6 Secrets** live only in Wrangler secrets / local untracked `.env`; rotation procedure documented.
- **NFR-S7 Standard security headers** on all responses (`X-Content-Type-Options`, `X-Frame-Options`/CSP, HSTS).

### 9.2 Integrity & reliability
- **NFR-R1 No double-booking** under concurrency (DB-level uniqueness).
- **NFR-R2 Timezone correctness:** slots and schedules respect the shop's timezone year-round (incl. BST transitions).
- **NFR-R3 No silent message loss:** queued reminders are delivered or retried, never dropped.
- **NFR-R4 Graceful degradation:** API outage shows a friendly error page, never a blank crash (error boundaries; defensive parsing of cached/stored JSON).
- **NFR-R5 Schema ownership:** one component owns schema + migrations, applied in order with tracking; no runtime cross-worker table creation dependencies.

### 9.3 Quality gates
- **NFR-Q1 CI gates:** type-check, lint, and tests must pass before any deploy.
- **NFR-Q2 Test coverage:** unit tests for slot calculation, booking conflict, auth/session logic; E2E only against staging.
- **NFR-Q3 Environments:** production and staging are separate (D1/KV namespaces); E2E never mutates production.
- **NFR-Q4 Single source of truth** for shared types and utilities (`@repo/types`, `@repo/utils`) — no drift between schema, types, and route code.

### 9.4 Compliance
- **NFR-C1** GDPR + PECR: cookie consent, marketing opt-in, data export/deletion on request.
- **NFR-C2** UK-English copy; no em-dashes in user-facing text (house style).

## 10. Success metrics

- **Business:** shops onboarded, monthly booking volume & GMV, commission revenue, shop churn (target ~0 at setup via white-glove onboarding), no-show rate reduction per shop.
- **Product:** booking completion rate (target: beat the 71% industry abandonment problem), time-to-book (guest flow), % bookings outside business hours, walk-in queue adoption.
- **Platform health:** API error rate, p95 latency, zero cross-tenant incidents, CI pass rate, deploy frequency.

## 11. Risks & open items

- The June 2026 code review found gaps against NFR-S1–S7, R1–R5, Q1–Q4 — remediation is planned and prioritized in [docs/superpowers/plans/2026-06-12-remediation-task-list.md](superpowers/plans/2026-06-12-remediation-task-list.md).
- Single shared production database across all environments until NFR-Q3 lands (highest operational risk).
- Phase 3 AI features depend on per-shop cost controls (NFR-S4) being in place first.
