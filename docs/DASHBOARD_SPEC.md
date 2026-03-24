# Pivot Parlor — Dashboard Audit & Implementation Plan
**Document type**: Technical Specification
**Date**: March 2026
**Scope**: All 4 role-based dashboards — Developer, Admin, Staff, Customer

---

## EXECUTIVE SUMMARY

After reviewing all 4 dashboards against the current codebase and industry standards, the dashboards are in a **stub state**. They have correct structure and auth guards, but most data connections are placeholder comments or empty. The 4 dashboards need to be fully wired to live data before Pivot Parlor can support a proper shop transaction and operational workflow.

---

## 1. SECURITY & DATA ISOLATION AUDIT

### Current security posture: PASS on architecture, GAPS on implementation

**What's correctly in place:**
- JWT-based auth with role verification via `requireRole()` before every loader
- Multi-tenant `shop_id` scoping enforced at Worker query level
- All Worker mutations require `authMiddleware` + `requireShop()`
- Prepared statements throughout — no SQL injection risk
- Secrets via `wrangler secret put`, never hardcoded

**Gaps identified:**

| Gap | File | Risk | Fix |
|-----|------|------|-----|
| `admin._index.tsx` calls `/api/admin/stats` — this endpoint doesn't exist in the Worker | admin._index.tsx | Silent failure, no data | Add Worker endpoint |
| `admin.bookings.tsx` calls `/api/bookings` without shop scoping — returns all bookings if endpoint exists | admin.bookings.tsx | **CRITICAL cross-tenant leak risk** | Must call `/api/shops/:shopId/bookings` |
| `staff._index.tsx` calls `/api/staff/today` — endpoint doesn't exist | staff._index.tsx | No data shown | Add Worker endpoint |
| `staff.bookings.tsx` calls `/api/staff/bookings` — endpoint doesn't exist | staff.bookings.tsx | No data shown | Add Worker endpoint |
| `dev.revenue.tsx` has no data connection at all | dev.revenue.tsx | No revenue visibility for developer | Wire to existing `getPlatformRevenueByMonth` |
| `admin.revenue.tsx` has no data connection at all | admin.revenue.tsx | No revenue visibility for admin | Wire to existing `getRevenueByShop` |
| `admin.schedule.tsx` uses hardcoded fake staff names | admin.schedule.tsx | Wrong data shown | Load real staff + schedules |
| `staff.availability.tsx` shows hardcoded "Off" for all days | staff.availability.tsx | Wrong availability data | Load real schedule from DB |
| `account._index.tsx` "My bookings" section is "Coming soon" | account._index.tsx | Customer can't see their bookings | Wire to customer booking history |
| `admin.bookings.tsx` shows `b.customerId` / `b.serviceId` raw IDs | admin.bookings.tsx | UX: meaningless IDs instead of names | Bookings query already JOINs names |

### Inter-tenant data leakage — critical analysis

The most serious risk is the `/api/bookings` call in `admin.bookings.tsx`:
```typescript
// DANGEROUS — if this endpoint exists and returns cross-shop data:
bookings = await api.get("/api/bookings");
```

The Worker's `publicBookings` router handles `POST /api/bookings` (customer-facing booking creation). There is no `GET /api/bookings` endpoint in the Worker. So currently it fails silently (returns `[]`). But if someone adds a `GET /api/bookings` without shop scoping, all bookings across all shops would be exposed to any authenticated admin.

**Fix**: Always call `/api/shops/:shopId/bookings` with the admin's own `shop_id` from their JWT.

### Industry standard: Role-based data boundaries

| Role | Data access boundary | What they must NEVER see |
|------|---------------------|--------------------------|
| **Developer** | All shops, all revenue, platform-level aggregates | Individual customer PII beyond what's needed for support |
| **Admin** | Their shop_id ONLY — all staff, services, bookings, revenue within their shop | Other shops' data, payment card details, platform-level commission breakdown |
| **Staff** | Their own staff_id — only their own bookings and schedule | Other staff's bookings, any revenue/commission data, customer contact info beyond name |
| **Customer** | Their own bookings — by email match or user_id | Any other customer's data, staff schedules, shop revenue |

---

## 2. DASHBOARD-BY-DASHBOARD SPECIFICATION

---

### 2.1 DEVELOPER DASHBOARD (`/dev`)

**Purpose**: Platform operations — see all shops, revenue, health

**Current state**: Stats work (with placeholder endpoint), enquiries table works, revenue page is empty

**Industry standard reference**: Fresha developer console shows shop count, GMV (gross merchandise value), commission earned, and a list of shops with their status. Squire's operator dashboard shows per-shop revenue and booking trends.

**Required pages and data:**

#### `/dev` — Overview
```
Stats row (from /api/dev/stats — needs Worker endpoint):
  - Total active shops
  - Bookings this month (all shops)
  - Platform commission earned this month (£)
  - Pending enquiries

Recent enquiries table (already working)
Recent site generations feed (last 5 jobs + status)
```

#### `/dev/shops` — Shop Management (already working well)

#### `/dev/revenue` — Platform Revenue (currently empty)
```
Month selector (current month default)
Stats row:
  - Total gross bookings value
  - Total platform commission
  - Average commission per shop

Per-shop revenue table:
  Shop name | Bookings | Gross value | Commission | Status

Monthly trend chart (last 6 months bar chart)
```

**Worker endpoints needed:**
- `GET /api/dev/stats` — platform summary stats
- `GET /api/dev/revenue?year=&month=` — per-shop revenue breakdown (query helper `getPlatformRevenueByMonth` already exists)

**Security rules for developer dashboard:**
- All developer routes must call `requireRole(request, "developer", env.API_URL)`
- Revenue data shown as commission amounts only — never show individual customer PII
- Shop owner emails and contact details are shown (needed for operations)
- Never expose individual customer payment details — show booking counts and amounts only

---

### 2.2 ADMIN DASHBOARD (`/admin`)

**Purpose**: Shop owner manages their own shop's day-to-day operations

**Current state**: Overview stats placeholder, bookings broken (wrong endpoint, raw IDs), revenue empty, schedule fake data

**Industry standard reference**: Fresha admin shows today's appointments in a timeline, daily revenue, staff utilisation bars. Booksy admin shows a calendar view with bookings colour-coded by staff member. Squire admin shows queue status + upcoming bookings at a glance.

**Required pages and data:**

#### `/admin` — Overview
```
Stats row (from /api/shops/:shopId/stats or calculated in loader):
  - Today's bookings (count)
  - Today's revenue (completed bookings, £)
  - Active staff on shift today
  - Waitlist count

Today's booking timeline (time-ordered, with staff name, service, customer name)
Quick actions:
  - Add walk-in booking
  - Block time
  - View tomorrow
```

#### `/admin/bookings` — Booking Management
```
Date filter (today default, date picker)
Status filter (all, pending, confirmed, completed, cancelled, no_show)

Bookings table columns:
  Customer name | Service | Staff | Date/Time | Duration | Amount | Status | Actions

Actions per booking:
  - Confirm (pending → confirmed)
  - Complete (confirmed → completed) — triggers commission calculation
  - Cancel
  - Mark no-show

Booking detail drawer (click row):
  - Customer name, email, phone
  - Service + duration + price
  - Staff member
  - Notes
  - Full status history
```

#### `/admin/revenue` — Revenue & Earnings
```
Month/period selector

Stats row:
  - Gross bookings value (£)
  - Platform commission paid (10%)
  - Net earnings (gross - commission)
  - Completed bookings count

Weekly bar chart (bookings per day, current month)
Revenue per staff member table:
  Staff name | Bookings | Revenue generated | Commission | Net

Top services by revenue table:
  Service | Bookings | Revenue
```

#### `/admin/schedule` — Staff Schedule Management
```
Week view (current week default)
Staff rows × Day columns grid

Each cell:
  - Working hours (09:00–17:00) or "Off"
  - Booking count for that day
  - Quick add shift

Editable cells — save via PUT /api/shops/:shopId/schedules

Staff breakdown panel (click staff name):
  - Today's bookings
  - Services they offer
  - Edit schedule
```

#### `/admin/services` — Services (already built this session ✓)

#### `/admin/staff` — Staff Management (already built ✓)

#### `/admin/settings` — Shop Settings (already built ✓)

**Security rules for admin dashboard:**
- Every loader MUST call `requireRole(request, "admin", env.API_URL)`
- `shop_id` ALWAYS comes from JWT payload, never from URL params or form data
- Customer email/phone shown in booking detail — this is legitimate operational need
- Revenue shown as gross amounts — admins see their own commission costs but NOT other shops
- Staff member private contact info (personal email used for login) — do NOT expose on admin dashboard

---

### 2.3 STAFF DASHBOARD (`/staff`)

**Purpose**: Individual staff member sees only their own schedule and bookings for the day

**Current state**: Greeting works, today's schedule empty (endpoint missing), bookings empty (endpoint missing), availability shows fake "Off" data

**Industry standard reference**: Squire staff view shows the barber's own chair bookings for the day in a timeline. Fresha staff app shows next appointment, today's total, and quick customer notes. Key principle: staff see ONLY their own bookings — never other staff members' schedules or any revenue data.

**Required pages and data:**

#### `/staff` — Today (My Day)
```
Greeting with name
Next appointment card (most prominent):
  - Customer name
  - Service
  - Start time
  - Time until appointment ("in 45 minutes")
  - Customer notes

Today's schedule timeline:
  - All my bookings today, time-ordered
  - Click to see customer details (name, service, notes)
  - Status update button (confirm → in progress → complete)

Today's summary:
  - Bookings today: X
  - Hours booked: X of X available
  - Services today: list

Quick actions:
  - Mark next booking as started
  - Add note to current booking
```

#### `/staff/bookings` — My Bookings
```
Filter: upcoming (default) | past | today

Booking cards (not a table — more scannable):
  Customer name + service + date/time + status badge

Upcoming: show next 2 weeks
Past: show last 30 days

Status update actions on each card
```

#### `/staff/availability` — My Availability
```
Weekly schedule (READ ONLY — set by admin):
  Mon–Sun, hours or Off
  "Contact your manager to update working hours"

Time off requests:
  Date range picker
  Reason (optional)
  Submit request → POST /api/staff/time-off

Pending requests list:
  Date range | Reason | Status (pending/approved/denied)
```

**Security rules for staff dashboard:**
- `requireRole(request, "staff", env.API_URL)` on every loader
- staff_id MUST come from JWT payload — never from URL or form
- Staff see ONLY their own bookings (WHERE staff_id = JWT.staff_id)
- Staff NEVER see revenue, commission, or other staff data
- Customer contact details (email, phone) shown for their own booked customers only — needed for day-of contact
- Staff cannot see other staff availability or schedules

**Worker endpoints needed:**
- `GET /api/staff/me/today` — today's bookings for the authenticated staff member
- `GET /api/staff/me/bookings?filter=upcoming|past` — paginated bookings
- `GET /api/staff/me/schedule` — their weekly schedule rows
- `POST /api/staff/me/time-off` — submit time off request

Note: The staff_id is resolved on the Worker side from the JWT — the route is `/api/staff/me/...` not `/api/staff/:staffId/...` to prevent any possibility of a staff member accessing another's data by guessing IDs.

---

### 2.4 CUSTOMER DASHBOARD (`/account`)

**Purpose**: Customer views their own booking history and manages their account

**Current state**: Profile section works (name/email). "My bookings" section is "Coming soon" placeholder.

**Industry standard reference**: Fresha customer app shows upcoming bookings with rescheduling/cancellation, past bookings with ability to rebook. Booksy shows booking history with review prompts. Key principle: customers see only their own bookings identified by their user_id or email — absolutely no other customer data.

**Required pages and data:**

#### `/account` — My Account
```
Profile section (name, email — already works)

Upcoming bookings section:
  - Booking cards sorted by date ASC
  - Shop name | Service | Staff | Date/Time | Status
  - Actions: Cancel (if > 24hrs away), Add to calendar

Past bookings section:
  - Last 10 bookings, date DESC
  - Shop name | Service | Staff | Date | Completed/Cancelled/No-show
  - Actions: Rebook (pre-fills booking form for same service/staff)

No booking state:
  "You have no upcoming bookings. Discover shops on Pivot Parlor."
  [Browse shops button]
```

**Worker endpoints needed:**
- `GET /api/me/bookings` — all bookings for the authenticated user (by user_id from JWT)
  Returns: upcoming + past, joined with shop name + service name + staff name

**Security rules for customer dashboard:**
- `requireRole(request, "customer", env.API_URL)` on every loader
- Bookings fetched by `user_id` from JWT — NEVER by email param or URL
- Customer sees ONLY their own bookings
- Customer NEVER sees: other customers, staff schedules, any revenue data
- Phone numbers of staff NOT shown to customers (use shop contact number instead)

---

## 3. MISSING WORKER API ENDPOINTS

The following endpoints must be added to the Worker to support the dashboards:

### 3.1 Developer endpoints

```
GET /api/dev/stats
  Auth: developer role
  Returns: { total_shops, bookings_this_month, platform_commission, pending_enquiries }
  Query: SELECT COUNT shops, SUM bookings, SUM commission from bookings this month

GET /api/dev/revenue?year=YYYY&month=MM
  Auth: developer role
  Returns: per-shop revenue breakdown
  Query helper: getPlatformRevenueByMonth (already exists in queries.ts)
```

### 3.2 Admin endpoints

```
GET /api/shops/:shopId/stats?date=YYYY-MM-DD
  Auth: admin role, shop scoped
  Returns: { todays_bookings, todays_revenue, active_staff, waitlist_count }

GET /api/shops/:shopId/bookings
  Auth: admin role, shop scoped
  Already exists — fix frontend to call correct URL

GET /api/shops/:shopId/revenue?year=YYYY&month=MM
  Auth: admin role, shop scoped
  Query helper: getRevenueByShop (already exists)
  Plus: per-staff breakdown, per-service breakdown

GET /api/shops/:shopId/schedules
  Auth: admin role, shop scoped
  Returns: schedules joined with staff names

PUT /api/shops/:shopId/schedules
  Auth: admin role, shop scoped
  Upserts schedule rows per staff per day
  Query helper: upsertSchedule (already exists)
```

### 3.3 Staff endpoints

```
GET /api/staff/me/today
  Auth: staff role
  Resolves staff record from JWT user_id
  Returns: today's bookings for this staff member with customer + service details

GET /api/staff/me/bookings?filter=upcoming|past&limit=20&offset=0
  Auth: staff role
  Returns: paginated bookings for this staff member only

GET /api/staff/me/schedule
  Auth: staff role
  Returns: schedule rows for this staff member (7 days)

POST /api/staff/me/time-off
  Auth: staff role
  Body: { from_date, to_date, reason? }
  Creates time-off request (new table: staff_time_off)
```

### 3.4 Customer endpoints

```
GET /api/me/bookings
  Auth: customer role
  Resolves user from JWT
  Returns: all bookings for this user joined with shop + service + staff names
  Ordered: upcoming ASC, then completed DESC
```

---

## 4. NEW MIGRATION NEEDED

```sql
-- Migration 012: staff_time_off
CREATE TABLE IF NOT EXISTS staff_time_off (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id    TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_time_off_staff ON staff_time_off(staff_id);
CREATE INDEX IF NOT EXISTS idx_time_off_shop  ON staff_time_off(shop_id);
```

---

## 5. LEGAL & ETHICAL COMPLIANCE

### UK GDPR compliance for dashboards

| Data shown | Role | Legal basis | Retention shown |
|------------|------|-------------|-----------------|
| Customer name + email in bookings | Admin | Legitimate interest (service delivery) | Active bookings + 3 years |
| Customer phone in booking detail | Admin + Staff | Legitimate interest (day-of contact) | Active bookings only |
| Staff email in admin panel | Admin | Legitimate interest (employment) | While staff is active |
| Revenue data | Admin (own shop), Developer | Legitimate interest (commercial) | Up to 7 years |
| Booking history | Customer (own only) | Contract performance | 3 years |

### Data minimisation rules (GDPR Article 5)

1. **Staff dashboard**: Do NOT show customer email/phone in the bookings list. Show in the booking detail view only. This limits exposure to the working context where it's needed.

2. **Admin dashboard**: Do NOT show full card numbers or Stripe payment IDs — show booking amount only. Payment details stay in Stripe.

3. **Developer dashboard**: Do NOT show individual customer names or emails in platform-level revenue reports — show aggregated numbers per shop only.

4. **Customer dashboard**: Show customer their own data only. Do NOT show which specific staff member's phone/email to contact — use the shop's contact number.

### Right to erasure (GDPR Article 17)

When a customer requests deletion:
- Anonymise their records: replace name with "Deleted Customer", email with a hash, phone with null
- Do NOT delete booking records — needed for commission auditing and financial compliance (7-year retention)
- Staff time-off records: delete immediately on request

### Data export (GDPR Article 20 — portability)

Customer account page should have a "Download my data" button:
- Generates JSON of all their bookings
- No other customers' data included
- Logs the export event

---

## 6. IMPLEMENTATION ORDER

Build in this exact sequence — each step unblocks the next:

### Step 1 — Worker: Add missing API endpoints (apps/worker)
Priority order:
1. `GET /api/shops/:shopId/stats` — unblocks admin overview
2. Fix `GET /api/shops/:shopId/bookings` response shape — unblocks admin bookings
3. `GET /api/staff/me/today` + `GET /api/staff/me/bookings` — unblocks staff dashboard
4. `GET /api/me/bookings` — unblocks customer dashboard
5. `GET /api/dev/stats` + `GET /api/dev/revenue` — unblocks developer revenue
6. `GET /api/shops/:shopId/revenue` — unblocks admin revenue

### Step 2 — Migration 012 (staff_time_off table)

### Step 3 — Admin Dashboard (highest business impact)
1. `admin._index.tsx` — wire to real stats + booking timeline
2. `admin.bookings.tsx` — fix endpoint, show names, add status actions
3. `admin.revenue.tsx` — wire to revenue endpoint, add charts
4. `admin.schedule.tsx` — load real staff + schedules, make editable

### Step 4 — Staff Dashboard
1. `staff._index.tsx` — next appointment card, today's timeline
2. `staff.bookings.tsx` — real data with status updates
3. `staff.availability.tsx` — real schedule + time-off request form

### Step 5 — Customer Dashboard
1. `account._index.tsx` — upcoming + past bookings, rebook action

### Step 6 — Developer Dashboard
1. `dev.revenue.tsx` — per-shop breakdown + trend chart

---

## 7. DASHBOARD DESIGN STANDARDS

Based on industry research (Fresha, Booksy, Squire, Mangomint):

### Admin overview — the "morning check" pattern
The most-used dashboard view in the industry. Admin opens it every morning to see:
1. **What's happening today** — most prominent. Timeline or list of today's bookings.
2. **Money summary** — today's expected revenue and this week's total.
3. **Staff status** — who's in, who's off.
4. **Alerts** — no-shows from yesterday, waitlist entries, confirmations needed.

This is the pattern used by Fresha, Booksy, and Squire. Our admin overview currently shows stat cards but no today's timeline. The BookingTimeline component exists — it just needs real data.

### Staff view — the "next chair" pattern
Staff open the app to answer one question: "What do I do next?"
1. **Next appointment** — huge, obvious, counts down.
2. **Today's list** — everything after the next appointment.
3. Nothing else. Staff don't need revenue, settings, or other staff data.

### Customer view — the "my appointments" pattern
Customers open it to answer: "When is my next appointment and can I cancel?"
1. **Upcoming bookings** — next appointment first, prominently.
2. **Past bookings** — with rebook button.
3. No complexity. No admin features.

---

*Document maintained at: F:\Projects\Pivot Parlor\pivot-parlor\docs\DASHBOARD_SPEC.md*
*Update this document as each step is completed.*
