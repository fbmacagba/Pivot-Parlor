# Pivot Parlor — Master Task List
**Last updated: 29 March 2026 (Session 3)**
**Project path:** `F:\Projects\Pivot Parlor\pivot-parlor`
**GitHub:** `fbmacagba/Pivot-Parlor`
**Test shop:** `ferdyms-barber-shop-014` | `shop_id: daf88508-cb57-42b4-a5c2-953ff9e2a22c`

---

## PHASE 1 — Backend & Infrastructure ✅ COMPLETE

- [x] 6 Cloudflare Workers deployed
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

## PHASE 2 — Frontend & Admin

### Public Shop Website ✅ COMPLETE
- [x] CommercialTemplate.tsx — full redesign
- [x] Hero, stats bar, services, trust, CTA sections
- [x] Navbar, footer, inner pages (Privacy, Terms, Cookies)
- [x] Chatbot widget with KV rate limiting
- [x] Image upload (logo + hero via R2)
- [x] TemplateNavbar on all 6 AI templates
- [x] UK GDPR / PECR compliant legal pages
- [x] Dynamic shop address in legal docs
- [x] Step 3 copy fix: "Confirm your booking · No card required" ✅ 29 Mar

### Authentication & Routing ✅ COMPLETE
- [x] Unified /login page
- [x] Role-based redirects
- [x] Developer bypass + Switch View dropdown
- [x] Google OAuth (test mode)
- [x] LinkedIn OAuth
- [x] Facebook OAuth (code done, pending Meta business verification)

### Developer Dashboard (/dev) ✅ MOSTLY COMPLETE
- [x] Overview stats, shops table, AI deploy, revenue
- [x] Enquiries table with onboard flow
- [x] Enquiries: click message cell to expand full text in modal ✅ 29 Mar
- [ ] Cloudflare Turnstile on /contact ✅ 29 Mar (site key + secret set, deployed)
- [ ] Spam protection on shop chatbot endpoint

### Admin Dashboard (/admin) ✅ MOSTLY COMPLETE
- [x] Overview: today's bookings timeline, stats cards
- [x] Setup gate: 4-step progress screen (staff, services, address, Stripe) ✅ 29 Mar
- [x] Settings: contact/location, hours, social links
- [x] Staff: list, invite, edit name/bio, assign services, deactivate ✅ 29 Mar
- [x] Bookings: list view (grouped by date) + calendar toggle ✅ 29 Mar
- [x] Bookings: detail drawer with status update ✅ 29 Mar
- [x] Services: add / edit / archive
- [x] Revenue: gross, commission, net, per-staff, per-service, daily chart
- [x] Staff: avatar/photo upload ✅ 29 Mar (R2 upload + hover overlay UI)
- [ ] Schedule: weekly grid (Mon–Sun × staff), editable hours, block time off
- [ ] Notification preferences (email/SMS reminder timing)

### Staff Dashboard (/staff) ✅ COMPLETE
- [x] Today view: next appointment card, schedule timeline, completed collapsible
- [x] My bookings: upcoming/past/today filter
- [x] My availability: weekly schedule (read-only) + time-off request form

### Customer Dashboard (/account) ⏳ PENDING
- [ ] My Bookings: upcoming + past
- [ ] Booking detail: service, staff, date/time, status, cancel
- [ ] Profile: name, email, phone (editable)
- [ ] Customer registration from shop booking page

---

## PHASE 3 — Walk-in & Scanner System ⏳ PENDING

- [ ] QR code per shop (/{shopSlug}/walkin)
- [ ] Walk-in landing page: queue position + wait time
- [ ] Admin ScannerModal + NumericPad
- [ ] Queue management (KV-based, poll 30s)
- [ ] EOD queue clear

---

## PHASE 4 — Stripe & Payments ⏳ PENDING

- [ ] Stripe Connect onboarding for shop owners (Express account)
- [ ] Deposit collection (configurable % per shop)
- [ ] 10% commission auto-split (Destination Charges)
- [ ] EOD alert to developer (booking count only)
- [ ] Refund handling
- [ ] Payout schedule display

---

## PHASE 5 — Growth & Marketing ⏳ PENDING

- [ ] Review collection: post-booking email + display on shop site
- [ ] SEO: meta title, OG tags per shop
- [ ] Google Business Profile link per shop
- [ ] Analytics dashboard (booking trends, peak hours)
- [x] Email notifications via Resend ✅ 29 Mar (confirmation + 24h reminder, dark branded HTML)

---

## KNOWN BUGS & TECH DEBT

- [x] KV cache bust after image upload ✅ 29 Mar (now deletes site:{slug} immediately)
- [x] CommercialTemplate Step 3 copy misalignment ✅ 29 Mar
- [x] Enquiries: expand full message ✅ 29 Mar
- [x] Turnstile on /contact ✅ 29 Mar
- [ ] Staff avatar upload UI (worker endpoint exists, frontend pending)
- [ ] Google OAuth still in test mode — add real users in Google Auth Platform → Audience
- [ ] Facebook OAuth pending Meta business portfolio verification
- [ ] Cookie consent banner (PlatformCookieBanner exists but categories/localStorage not wired)
- [ ] Cloudflare Turnstile on shop chatbot endpoint

---

## PENDING SECRETS / ACTIONS

| Item | Status |
|---|---|
| `RESEND_API_KEY` | ✅ Set — Stripe Connect + email features ready to test |
| `TURNSTILE_SECRET_KEY` | ✅ Set 29 Mar |
| Turnstile site key in code | ✅ `0x4AAAAAACxPFNWfoxKge7a9` |
| Facebook OAuth secrets | ⏳ Pending Meta business verification |
| Google OAuth — production mode | ⏳ Add real users or publish app |

---

## INFRASTRUCTURE REFERENCE

| Resource | Value |
|---|---|
| D1 Database | `pivot-parlor-db` — `515a7270-81b4-4935-b106-15aeee639f57` |
| KV | `pivot-parlor-api-KV` — `12eca802e7ff47c2a5358da0f985eecd` |
| R2 | `pivot-parlor-assets` |
| API Worker | `https://pivot-parlor-api.bmorris0565.workers.dev` |
| Pages | `https://pivot-parlor-web.pages.dev` |
| Cloudflare Account ID | `107ddadecf5d982d0dc11c72affcce79` |

---

## DEPLOY COMMANDS (PowerShell — never WSL)

```powershell
# Worker
cd 'F:\Projects\Pivot Parlor\pivot-parlor\apps\worker'
npx wrangler deploy

# Frontend
cd 'F:\Projects\Pivot Parlor\pivot-parlor\apps\web'
npm run deploy

# Pull latest before deploying
cd 'F:\Projects\Pivot Parlor\pivot-parlor'
git fetch origin
git reset --hard origin/main
```

---

## SESSION LOG

| Date | Session | Key deliverables |
|---|---|---|
| 23 Mar | S1 | Infrastructure, schema, auth, RBAC, booking flow, AI generation |
| 24 Mar | S2 | CommercialTemplate, legal pages, OAuth, developer dashboard |
| 29 Mar | S3 | Admin bookings (list+calendar), setup gate, staff management (edit/assign/deactivate), KV cache bust, enquiries modal, Turnstile on /contact, staff avatar upload, Resend emails (confirmation + reminder) |
