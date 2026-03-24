# Pivot Parlor — Master Task List
**Last updated: 24 March 2026 (Session 2)**
**Project path:** `F:\Projects\Pivot Parlor\pivot-parlor`
**GitHub:** `fbmacagba/Pivot-Parlor`
**Test shop:** `ferdyms-barber-shop-014` | `shop_id: daf88508-cb57-42b4-a5c2-953ff9e2a22c`

---

## PHASE 1 — Backend & Infrastructure ✅ COMPLETE

- [x] 6 Cloudflare Workers deployed (research, images, assembler, audit, booking, chatbot)
- [x] 29 D1 tables created and seeded
- [x] KV, R2, Queues configured
- [x] Hono API worker with auth (JWT), RBAC, CORS
- [x] Stripe Connect Express + Destination Charges
- [x] Site generation pipeline (4-worker queue)
- [x] Booking flow (service → staff → slot → confirm)
- [x] Waitlist system
- [x] Reminder queue (24h before booking)
- [x] AI theme generation (OpenRouter)
- [x] Image generation (FLUX / Gemini via OpenRouter)
- [x] Playwright E2E tests (mocked AI endpoints)

---

## PHASE 2 — Frontend & Admin ✅ MOSTLY COMPLETE

### Public Shop Website
- [x] CommercialTemplate.tsx — full redesign (hero, stats bar, services, trust, CTA)
- [x] Hero section: headline from DB, tagline, social proof badge, dual CTAs, trust line
- [x] Stats bar: Happy Clients, Average Rating, Same-Day Slots
- [x] Services section: cards with duration, price, Book This CTA
- [x] Why book with us: about text + 3 trust pillars
- [x] How it works: 3-step flow
- [x] Final CTA banner
- [x] Navbar (sticky): logo, Home/Services/Book links, Book Now button, mobile hamburger
- [x] Footer: social media icons (toggleable), nav links, Powered by Pivot Parlor, copyright
- [x] Inner pages: Privacy Policy, Terms of Service, Cookie Policy (per shop, dynamic)
- [x] Chatbot widget (floating FAB, chat window, typing indicator, markdown links)
- [x] Chatbot rate limiting (50 msg/hour, 200 msg/day per shop via KV)
- [x] Image upload: logo + hero (R2), mockup preview refreshes, saved state UX
- [x] TemplateNavbar — Sign In button added to all 6 AI-generated templates (Classic, Luxury, Minimal, Fresh, Vibrant, Editorial)
- [x] Inner pages rewritten: Privacy Policy, Terms of Service, Cookie Policy — full UK GDPR / PECR compliance
- [x] ShopLegalDocument updated: accepts address prop, shows business address in highlighted box when available
- [x] Address placeholder: when Admin saves address in Settings it auto-populates all 3 legal documents

### Cookie Compliance ⏳ PENDING
- [ ] Cookie consent banner (bottom bar, first visit only)
- [ ] Three categories: Essential (always on), Analytics (toggleable), Marketing (toggleable)
- [ ] Consent stored in localStorage per visitor
- [ ] No tracking scripts load before consent
- [ ] "Manage preferences" link in footer opens cookie settings modal
- [ ] Cookie Policy page wired to consent manager

### Authentication & Routing
- [x] Unified /login page (email + password, Pivot Parlor branding)
- [x] Role-based redirect: developer→/dev/dashboard, admin→/admin, staff→/staff, customer→/account
- [x] Developer access to all dashboards (requireRole bypass for developer)
- [x] Switch View dropdown in sidebar (developer only)
- [x] Developer View banner on admin/customer dashboards
- [x] Customer account placeholder (/account)
- [x] /dev/login redirects to /login
- [x] Social login: Google OAuth live (Google Cloud — External app, test mode)
- [x] Social login: LinkedIn OAuth live
- [x] Social login: Facebook OAuth — code complete, secrets pending (business portfolio issue)
- [x] oauth_accounts D1 table (migration 011) — live in production
- [x] Login page updated: Google + LinkedIn + Facebook buttons + email/password fallback

### Developer Dashboard (/dev)
- [x] Overview: Total shops, Bookings this month, Platform commission, Pending enquiries
- [x] Shops table: shop number, name, type, owner, status, actions
- [x] AI Deploy: generate/regenerate site per shop
- [x] Revenue breakdown
- [x] Enquiries table (read all messages from D1)
- [ ] Enquiries: click to expand full message in modal
- [ ] Spam protection: Cloudflare Turnstile on contact form

### Admin Dashboard (/admin) ⏳ PARTIALLY COMPLETE
- [x] Settings page: contact/location, opening hours (Mon–Sun), social media links
- [x] Staff list + add staff (with developer shopId bypass fix)
- [ ] Staff: edit staff details, assign services per staff member, deactivate staff
- [ ] Staff: avatar/photo upload
- [ ] Schedule: weekly grid (Mon–Sun × staff rows), editable working hours, block time off
- [ ] Bookings: calendar + list toggle, filter by staff/service/status/date
- [ ] Bookings: confirm / cancel / mark complete / mark no-show actions
- [ ] Services: add / edit / archive services (name, duration, price, category)
- [ ] Revenue: bookings revenue vs commission paid, per-service breakdown, per-staff breakdown
- [ ] Admin overview: Today's bookings timeline, staff on duty, revenue today/week/month, waitlist count
- [ ] Notification preferences (email/SMS reminder timing)

### Staff Dashboard (/staff) ⏳ PENDING
- [ ] Today view: my schedule timeline, next booking card, upcoming bookings
- [ ] My bookings: past + upcoming, filter by date/status
- [ ] My availability: weekly schedule view, request time off

### Customer Dashboard (/account) ⏳ PENDING
- [ ] My Bookings: list of upcoming and past bookings
- [ ] Booking detail: service, staff, date/time, status, cancel option
- [ ] Profile: name, email, phone (editable)
- [ ] Customer registration flow (from shop booking page — optional account creation)

---

## PHASE 3 — Walk-in & Scanner System ⏳ PENDING

### Prerequisites (must be done first)
- [x] Admin Settings page (address, hours) — DONE

### ScannerModal
- [ ] QR code generation per shop (unique URL: /{shopSlug}/walkin)
- [ ] Walk-in landing page: shows queue position, estimated wait time
- [ ] Customer enters name + phone on walk-in page
- [ ] Admin/staff ScannerModal: scan QR or manual entry
- [ ] Queue display: list of walk-ins with position, service requested, wait time

### NumericPad
- [ ] Staff-facing numeric pad for quick walk-in check-in
- [ ] Enter customer queue number to pull up their record
- [ ] Mark as served / skip / remove from queue

### Queue Management
- [ ] Real-time queue updates (KV-based, poll every 30s)
- [ ] EOD queue clear (automated at closing time based on hours_json)
- [ ] Walk-in vs booked appointment view (separate lanes)

---

## PHASE 4 — Stripe & Payments ⏳ PENDING

- [ ] Stripe Connect onboarding flow for shop owners (Express account)
- [ ] Setup gate: staff + services + Stripe Connect + address required before go-live
- [ ] Deposit collection on booking (configurable % per shop)
- [ ] 10% commission auto-split on completed bookings (Destination Charges)
- [ ] Product commission toggle (off by default, dev-toggleable)
- [ ] Commission bearer toggle (shop default, dev-toggleable)
- [ ] EOD alert to developer: booking count only (no amounts)
- [ ] Refund handling (partial/full via Stripe)
- [ ] Payout schedule display for shop owners

---

## PHASE 5 — Growth & Marketing ⏳ PENDING

- [ ] Review collection: post-booking email with review link
- [ ] Review display on shop public site (star rating + testimonials)
- [ ] SEO: meta title, description, OG tags per shop (from shop_sites.seo_title/seo_description)
- [ ] Google Business Profile link per shop
- [ ] Referral system: shop refers another shop → commission discount
- [ ] Email notifications: booking confirmation, reminder, cancellation (via Resend/Mailgun)
- [ ] SMS reminders (via Twilio — optional)
- [ ] Analytics dashboard for shop owners (booking trends, popular services, peak hours)

---

## KNOWN BUGS & TECH DEBT

- [ ] KV cache bust needed after image upload (currently requires 24h TTL expiry)
- [ ] Enquiries page: expand full message in modal (currently truncated in table)
- [ ] Spam protection (Cloudflare Turnstile) on contact form at pivotparlor.com/contact
- [ ] Service images: placeholder shown for all services (no per-service image upload yet)
- [ ] Step 3 in "How it works" says "Confirm & pay" but hero says "No card required" — copy misalignment
- [ ] Facebook OAuth pending: blocked by Meta business portfolio verification requirement
- [ ] Google OAuth in test mode — add real users via Google Auth Platform → Audience before going public
- [x] Inner pages: deployed and live (24 Mar 2026 S2)

---

## INFRASTRUCTURE REFERENCE

| Resource | Value |
|---|---|
| D1 Database | `pivot-parlor-db` — `515a7270-81b4-4935-b106-15aeee639f57` |
| KV | `pivot-parlor-api-KV` — `12eca802e7ff47c2a5358da0f985eecd` |
| R2 | `pivot-parlor-assets` |
| API Worker | `https://pivot-parlor-api.bmorris0565.workers.dev` |
| Chatbot Worker | `https://pivot-parlor-chatbot.bmorris0565.workers.dev` |
| Pages | `https://pivot-parlor-web.pages.dev` |
| Cloudflare Account ID | `107ddadecf5d982d0dc11c72affcce79` |

### Worker Secrets (set via `wrangler secret put --name pivot-parlor-api`)
| Secret | Status |
|---|---|
| JWT_SECRET | ✅ |
| OPENROUTER_API_KEY | ✅ |
| STRIPE_SECRET_KEY | ✅ |
| STRIPE_WEBHOOK_SECRET | ✅ |
| GOOGLE_OAUTH_CLIENT_ID | ✅ |
| GOOGLE_OAUTH_CLIENT_SECRET | ✅ |
| LINKEDIN_OAUTH_CLIENT_ID | ✅ |
| LINKEDIN_OAUTH_CLIENT_SECRET | ✅ |
| FACEBOOK_OAUTH_APP_ID | ⏳ pending |
| FACEBOOK_OAUTH_APP_SECRET | ⏳ pending |

### Deploy Commands (PowerShell — always use PowerShell, not WSL)
```powershell
# Deploy worker only
cd "F:\Projects\Pivot Parlor\pivot-parlor\apps\worker"
npx wrangler deploy

# Deploy Pages only
cd "F:\Projects\Pivot Parlor\pivot-parlor\apps\web"
npm run deploy

# Run D1 migration
cd "F:\Projects\Pivot Parlor\pivot-parlor\apps\worker"
wrangler d1 execute pivot-parlor-db --remote --file=src/db/migrations/NNN_name.sql

# Set a secret
wrangler secret put SECRET_NAME --name pivot-parlor-api
```

---

## PRICING MODEL
- £100 one-time setup fee per shop (onboarding + training + AI generation)
- 10% commission per completed booking (auto-split via Stripe)
- No monthly fees for shops
