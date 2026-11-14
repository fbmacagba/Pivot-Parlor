/**
 * Two bookings must never hold the same barber at the same time. Every
 * booking path checks for a clash and then inserts; when the check and the
 * insert are separate statements, a request arriving in between wins the
 * same time and both succeed. idx_bookings_active_slot (migration 018) only
 * stops an identical start string, so it misses an overlapping booking with
 * a different start (10:00 for an hour vs 10:30) and an online booking (an
 * instant) against a walk-in or deposit booking (the shop's "HH:MM") for the
 * same minute.
 *
 * The fix makes the clash check part of the insert (createBookingIfFree):
 * one statement, which D1 runs atomically. These tests prove it two ways:
 *  - the guarded insert agrees with checkSlotConflict (the JS reading of a
 *    clash every path already trusts) on a table of cases;
 *  - each route, with a competing booking slipped in between its checks and
 *    its insert (a wrapped DB), answers 409 and leaves only the competitor.
 * The race is simulated deterministically, not by truly parallel requests.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { seedScheduleDay, seedService, seedShop, seedStaff, slugFor, tokenFor } from "./helpers";
import { checkSlotConflict, createBookingIfFree } from "../src/db/queries";
import { getAvailableSlots } from "../src/services/slots";
import { zonedTimeToUtc, zonedWallClock } from "../src/lib/timezone";
import { shopToday } from "../src/lib/time";

const LONDON = "Europe/London";

type Row = { booking_date: string; start_time: string; end_time: string; status?: string };

async function seedRow(shop: string, staff: string, service: string, r: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence, commission_pence)
     VALUES (?, ?, ?, ?, 'Existing', 'existing@test.local', ?, ?, ?, ?, 2500, 250)`,
  )
    .bind(crypto.randomUUID(), shop, staff, service, r.booking_date, r.start_time, r.end_time, r.status ?? "confirmed")
    .run();
}

function candidateRow(shop: string, staff: string, service: string, r: Row) {
  return {
    id: crypto.randomUUID(),
    shop_id: shop,
    staff_id: staff,
    service_id: service,
    customer_name: "Candidate",
    customer_email: "candidate@test.local",
    customer_phone: null,
    booking_date: r.booking_date,
    start_time: r.start_time,
    end_time: r.end_time,
    notes: null,
    amount_pence: 2500,
    commission_pence: 250,
  };
}

/** The candidate's instants, as checkSlotConflict takes them. */
function instants(r: Row): { start: string; end: string } {
  if (/^\d{4}-/.test(r.start_time)) return { start: r.start_time, end: r.end_time };
  const start = zonedTimeToUtc(r.booking_date, r.start_time, LONDON);
  let end = zonedTimeToUtc(r.booking_date, r.end_time, LONDON);
  if (end <= start) end = new Date(end.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

const WINTER = "2099-01-15"; // London = UTC
const SUMMER = "2099-06-15"; // London = UTC+1

const CASES: Array<{ name: string; existing: Row; candidate: Row; clash: boolean; otherStaff?: boolean }> = [
  {
    name: "instant vs instant, different starts, overlapping",
    existing: { booking_date: WINTER, start_time: `${WINTER}T10:00:00.000Z`, end_time: `${WINTER}T11:00:00.000Z` },
    candidate: { booking_date: WINTER, start_time: `${WINTER}T10:30:00.000Z`, end_time: `${WINTER}T11:00:00.000Z` },
    clash: true,
  },
  {
    name: "instant vs instant, back to back",
    existing: { booking_date: WINTER, start_time: `${WINTER}T10:00:00.000Z`, end_time: `${WINTER}T10:30:00.000Z` },
    candidate: { booking_date: WINTER, start_time: `${WINTER}T10:30:00.000Z`, end_time: `${WINTER}T11:00:00.000Z` },
    clash: false,
  },
  {
    name: "a walk-in's clock time vs an online instant for the same minute (winter)",
    existing: { booking_date: WINTER, start_time: "10:00", end_time: "10:30" },
    candidate: { booking_date: WINTER, start_time: `${WINTER}T10:00:00.000Z`, end_time: `${WINTER}T10:30:00.000Z` },
    clash: true,
  },
  {
    name: "an online instant vs a clock time for the same minute (summer: 09:00Z is 10:00 in London)",
    existing: { booking_date: SUMMER, start_time: `${SUMMER}T09:00:00.000Z`, end_time: `${SUMMER}T09:30:00.000Z` },
    candidate: { booking_date: SUMMER, start_time: "10:00", end_time: "10:30" },
    clash: true,
  },
  {
    name: "a clock hour then an instant straight after it (summer: 10:00-11:00 London ends at 10:00Z)",
    existing: { booking_date: SUMMER, start_time: "10:00", end_time: "11:00" },
    candidate: { booking_date: SUMMER, start_time: `${SUMMER}T10:00:00.000Z`, end_time: `${SUMMER}T10:30:00.000Z` },
    clash: false,
  },
  {
    name: "clock vs clock, different starts, overlapping",
    existing: { booking_date: WINTER, start_time: "10:00", end_time: "11:00" },
    candidate: { booking_date: WINTER, start_time: "10:30", end_time: "11:00" },
    clash: true,
  },
  {
    name: "clock vs clock, back to back",
    existing: { booking_date: WINTER, start_time: "10:00", end_time: "10:30" },
    candidate: { booking_date: WINTER, start_time: "10:30", end_time: "11:00" },
    clash: false,
  },
  {
    name: "a clock booking running past midnight vs an instant early next day",
    existing: { booking_date: WINTER, start_time: "23:30", end_time: "00:30" },
    candidate: { booking_date: "2099-01-16", start_time: "2099-01-16T00:00:00.000Z", end_time: "2099-01-16T00:30:00.000Z" },
    clash: true,
  },
  {
    name: "a cancelled booking holds nothing",
    existing: { booking_date: WINTER, start_time: `${WINTER}T10:00:00.000Z`, end_time: `${WINTER}T11:00:00.000Z`, status: "cancelled" },
    candidate: { booking_date: WINTER, start_time: `${WINTER}T10:30:00.000Z`, end_time: `${WINTER}T11:00:00.000Z` },
    clash: false,
  },
  {
    name: "a no-show holds nothing",
    existing: { booking_date: WINTER, start_time: "10:00", end_time: "11:00", status: "no_show" },
    candidate: { booking_date: WINTER, start_time: "10:30", end_time: "11:00" },
    clash: false,
  },
  {
    name: "another barber's booking holds nothing",
    existing: { booking_date: WINTER, start_time: `${WINTER}T10:00:00.000Z`, end_time: `${WINTER}T11:00:00.000Z` },
    candidate: { booking_date: WINTER, start_time: `${WINTER}T10:30:00.000Z`, end_time: `${WINTER}T11:00:00.000Z` },
    clash: false,
    otherStaff: true,
  },
];

describe("createBookingIfFree agrees with checkSlotConflict", () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.clash ? "taken" : "free"}`, async () => {
      const shop = await seedShop(`Overlap ${c.name}`);
      const staff = await seedStaff(shop);
      const holder = c.otherStaff ? await seedStaff(shop) : staff;
      const service = await seedService(shop, 30);
      await seedRow(shop, holder, service, c.existing);

      const { start, end } = instants(c.candidate);
      expect(await checkSlotConflict(env.DB, staff, start, end, LONDON), "checkSlotConflict").toBe(c.clash);
      const result = await createBookingIfFree(env.DB, candidateRow(shop, staff, service, c.candidate), LONDON);
      expect(result, "createBookingIfFree").toBe(c.clash ? "taken" : "created");
      const active = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM bookings WHERE staff_id = ? AND status NOT IN ('cancelled', 'no_show')",
      )
        .bind(staff)
        .first<{ n: number }>();
      const before = c.otherStaff || c.existing.status ? 0 : 1;
      expect(active?.n, "active bookings for the candidate's barber").toBe(before + (c.clash ? 0 : 1));
    });
  }

  it("an identical start is taken, not an error", async () => {
    const shop = await seedShop("Overlap identical");
    const staff = await seedStaff(shop);
    const service = await seedService(shop, 30);
    const row = { booking_date: WINTER, start_time: `${WINTER}T10:00:00.000Z`, end_time: `${WINTER}T10:30:00.000Z` };
    await seedRow(shop, staff, service, row);
    expect(await createBookingIfFree(env.DB, candidateRow(shop, staff, service, row), LONDON)).toBe("taken");
  });

  it("zonedWallClock reads an instant on the shop's clock", () => {
    expect(zonedWallClock(new Date("2099-06-15T09:00:00.000Z"), LONDON)).toBe("2099-06-15 10:00");
    expect(zonedWallClock(new Date("2099-01-15T23:30:00.000Z"), LONDON)).toBe("2099-01-15 23:30");
    expect(zonedWallClock(new Date("2099-06-15T23:30:00.000Z"), LONDON)).toBe("2099-06-16 00:30");
  });
});

// ── The routes, with a competitor slipped in before their insert ─────────────

/** env with a DB that inserts `competitor` just before the route's own INSERT INTO bookings runs. */
function racing(competitor: () => Promise<unknown>) {
  const real = env.DB;
  let fired = 0;
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrapStmt(target.bind(...args));
        if (prop === "run") {
          return async () => {
            fired++;
            await competitor();
            return target.run();
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return /^\s*INSERT INTO bookings\b/.test(sql) ? wrapStmt(stmt) : stmt;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB: db }, fired: () => fired };
}

async function dispatchWith(
  e: unknown,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://booking.test${path}`, init) as never, e as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return res as unknown as Response;
}

async function activeBookings(staff: string): Promise<Array<{ customer_name: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT customer_name FROM bookings WHERE staff_id = ? AND status NOT IN ('cancelled', 'no_show')",
  )
    .bind(staff)
    .all<{ customer_name: string }>();
  return results;
}

async function competitorRow(shop: string, staff: string, service: string, r: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence, commission_pence)
     VALUES (?, ?, ?, ?, 'Competitor', 'competitor@test.local', ?, ?, ?, 'confirmed', 2500, 250)`,
  )
    .bind(crypto.randomUUID(), shop, staff, service, r.booking_date, r.start_time, r.end_time)
    .run();
}

describe("online booking (POST /public/bookings) loses a race cleanly", () => {
  async function setup() {
    const shop = await seedShop("Race Online");
    const staff = await seedStaff(shop);
    const service = await seedService(shop, 30);
    for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
    const slots = await getAvailableSlots(shop, staff, SUMMER, 30, env.DB, env.KV);
    const slot = slots.find((s) => s.is_available)!;
    return { shop, staff, service, start: new Date(slot.start_time), slug: await slugFor(shop) };
  }
  const book = (e: unknown, s: { slug: string; staff: string; service: string; start: Date }) =>
    dispatchWith(e, "POST", "/public/bookings", {
      body: {
        shop_slug: s.slug,
        staff_id: s.staff,
        service_id: s.service,
        date: SUMMER,
        start_time: s.start.toISOString(),
        customer_name: "Online",
        customer_email: "online@test.local",
      },
    });

  it("to an overlapping booking with a different start", async () => {
    const s = await setup();
    const at = (min: number) => new Date(s.start.getTime() + min * 60_000).toISOString();
    const race = racing(() => competitorRow(s.shop, s.staff, s.service, { booking_date: SUMMER, start_time: at(15), end_time: at(45) }));
    const res = await book(race.env, s);
    expect(race.fired()).toBe(1);
    expect(res.status).toBe(409);
    expect(await activeBookings(s.staff)).toEqual([{ customer_name: "Competitor" }]);
  });

  it("to a walk-in for the same minute on the shop's clock", async () => {
    const s = await setup();
    const local = zonedWallClock(s.start, LONDON); // "2099-06-15 HH:MM"
    const end = zonedWallClock(new Date(s.start.getTime() + 30 * 60_000), LONDON);
    const race = racing(() =>
      competitorRow(s.shop, s.staff, s.service, { booking_date: local.slice(0, 10), start_time: local.slice(11), end_time: end.slice(11) }),
    );
    const res = await book(race.env, s);
    expect(race.fired()).toBe(1);
    expect(res.status).toBe(409);
    expect(await activeBookings(s.staff)).toEqual([{ customer_name: "Competitor" }]);
  });

  it("control: to an identical start (already refused by idx_bookings_active_slot)", async () => {
    const s = await setup();
    const end = new Date(s.start.getTime() + 30 * 60_000).toISOString();
    const race = racing(() => competitorRow(s.shop, s.staff, s.service, { booking_date: SUMMER, start_time: s.start.toISOString(), end_time: end }));
    const res = await book(race.env, s);
    expect(race.fired()).toBe(1);
    expect(res.status).toBe(409);
    expect(await activeBookings(s.staff)).toEqual([{ customer_name: "Competitor" }]);
  });
});

describe("walk-in and staff deposit bookings lose a race cleanly", () => {
  async function openShop(name: string) {
    const shop = await seedShop(name);
    await env.DB.prepare("UPDATE shops SET setup_completed = 1, stripe_connect_account_id = 'acct_race' WHERE id = ?")
      .bind(shop)
      .run();
    const staff = await seedStaff(shop);
    const service = await seedService(shop, 30);
    for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d); // 09:00-17:00
    const auth = { Authorization: `Bearer ${await tokenFor("admin", shop)}` };
    const open = await dispatchWith(env, "POST", `/booking/shops/${shop}/open`, { headers: auth, body: {} });
    expect(open.status).toBe(200);
    return { shop, staff, service, auth, today: shopToday(LONDON) };
  }
  async function claimed(shop: string, staff: string, date: string, time: string): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT is_booked FROM bw_availability WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND slot_time = ?",
    )
      .bind(shop, staff, date, time)
      .first<{ is_booked: number }>();
    return Number(row?.is_booked);
  }
  /** An online booking (instants) at `time` on the shop's clock today. */
  const onlineAt = (s: { shop: string; staff: string; service: string; today: string }, time: string, minutes = 30) => {
    const start = zonedTimeToUtc(s.today, time, LONDON);
    return competitorRow(s.shop, s.staff, s.service, {
      booking_date: s.today,
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + minutes * 60_000).toISOString(),
    });
  };

  it("a walk-in, to an online booking for the same minute", async () => {
    const s = await openShop("Race Walk-in");
    const race = racing(() => onlineAt(s, "09:00"));
    const res = await dispatchWith(race.env, "POST", `/booking/shops/${s.shop}/walk-ins`, {
      headers: s.auth,
      body: { serviceId: s.service, staffId: s.staff, customerName: "Walk In" },
    });
    expect(race.fired()).toBe(1);
    expect(res.status).toBe(409);
    expect(await activeBookings(s.staff)).toEqual([{ customer_name: "Competitor" }]);
    expect(await claimed(s.shop, s.staff, s.today, "09:00")).toBe(0);
  });

  it("a staff deposit booking, to an overlapping online booking with a different start", async () => {
    const s = await openShop("Race Deposit");
    const race = racing(() => onlineAt(s, "11:15"));
    const res = await dispatchWith(race.env, "POST", `/booking/shops/${s.shop}/bookings`, {
      headers: s.auth,
      body: {
        serviceId: s.service,
        staffId: s.staff,
        slotDate: s.today,
        slotTime: "11:00",
        customerName: "Dee Posit",
        customerEmail: "dee@test.local",
        customerPhone: "",
      },
    });
    expect(race.fired()).toBe(1);
    expect(res.status).toBe(409);
    expect(await activeBookings(s.staff)).toEqual([{ customer_name: "Competitor" }]);
    expect(await claimed(s.shop, s.staff, s.today, "11:00")).toBe(0);
  });
});
