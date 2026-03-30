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
- [x] Cloudflare Turnstile on /contact ✅ 29 Mar
- [x] Marketing chatbot rate limiting: 20 msg/hr per IP via KV ✅ 29 Mar

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
- [x] Schedule: weekly grid per staff ✅ (already built)
- [x] Notification preferences: confirmation, reminder (timing selector), review request ✅ 30 Mar

### Staff Dashboard (/staff) ✅ COMPLETE
- [x] Today view: next appointment card, schedule timeline, completed collapsible
- [x] My bookings: upcoming/past/today filter
- [x] My availability: weekly schedule (read-only) + time-off request form

### Customer Dashboard (/account) ⏳ PENDING
- [x] My Bookings: upcoming + past ✅ (already built)
- [x] Booking detail ✅ (already built)
- [x] Profile: name + phone editable ✅ 29 Mar
- [x] Customer account dashboard ✅ (already built — upcoming/past bookings, profile edit)

---

## PHASE 3 — Walk-in & Scanner System ⏳ PENDING

- [x] QR code per shop — admin queue page shows scannable QR ✅ 30 Mar
- [x] Walk-in landing page: join form, queue position, auto-poll 30s ✅ 30 Mar
- [x] Admin queue page: Call next, Skip, Remove, Clear queue ✅ 30 Mar
- [x] Queue management: KV cache bust, admin poll proxy ✅ 30 Mar
- [x] EOD queue clear: DELETE /api/shops/:id/walkin clears all ✅ 30 Mar

---

## PHASE 4 — Stripe & Payments ⏳ PENDING

- [x] Setup/stripe page: £100 payment gate UI ✅ 29 Mar
- [ ] Stripe Connect Express account for payouts (Phase 4 — post-launch)
- [ ] Deposit collection (configurable % per shop)
- [ ] 10% commission auto-split (Destination Charges)
- [x] EOD alert to developer 20:00 UTC ✅ 29 Mar
- [ ] Refund handling
- [ ] Payout schedule display

---

## PHASE 5 — Growth & Marketing ⏳ PENDING

- [x] Review collection: post-booking email + modal + display ✅ 29 Mar
- [x] SEO: OG + Twitter card meta on shop pages ✅ 29 Mar
- [ ] Google Business Profile link per shop
- [ ] Analytics dashboard (booking trends, peak hours)
- [x] Email notifications via Resend ✅ 29 Mar (confirmation + 24h reminder, dark branded HTML)

---

## KNOWN BUGS & TECH DEBT

- [x] KV cache bust after image upload ✅ 29 Mar (now deletes site:{slug} immediately)
- [x] CommercialTemplate Step 3 copy misalignment ✅ 29 Mar
- [x] Enquiries: expand full message ✅ 29 Mar
- [x] Turnstile on /contact ✅ 29 Mar
- [x] Staff avatar upload ✅ 29 Mar
- [ ] Google OAuth still in test mode — add real users in Google Auth Platform → Audience
- [ ] Facebook OAuth pending Meta business portfolio verification
- [x] Cookie consent banner ✅ (fully wired — localStorage + categories)
- [x] Cloudflare Turnstile on shop chatbot endpoint ✅ 30 Mar

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
| 29 Mar | S3 | Admin bookings, setup gate, staff mgmt+avatars, Resend emails (confirm+reminder+EOD+review request), review collection, OG meta, chatbot rate limiting, customer profile edit, setup/stripe page, health-check.mjs (33/33) |
