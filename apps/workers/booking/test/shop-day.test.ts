import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { seedService, seedShop, seedStaff, slugFor, tokenFor } from "./helpers";

/**
 * The booking worker's day is the shop's day. A UK shop's day starts at
 * midnight London time, which in British Summer Time is 23:00 UTC the evening
 * before. Every "today" (day open and close, walk-ins, a sale's business day,
 * the sales list), every booking's booking_date, and every "sales on this
 * day" sum must use the shop's calendar, not UTC's. Before this, from 00:00 to
 * 01:00 London in summer the worker filed everything under yesterday.
 *
 * In winter London is on GMT, which equals UTC, so nothing changes; the
 * control at the end shows that.
 */

// 00:30 London on Thursday 2 July 2026 (BST): still 1 July in UTC.
const JUST_AFTER_MIDNIGHT_BST = new Date("2026-07-01T23:30:00Z");
// 09:00 London on 2 July 2026.
const MORNING_BST = new Date("2026-07-02T08:00:00Z");
// 23:00 London on 2 July 2026: 22:00 UTC, still 2 July both ways.
const LATE_EVENING_BST = new Date("2026-07-02T22:00:00Z");

function at(instant: Date): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
}

afterEach(() => {
  vi.useRealTimers();
});

/** A set-up shop whose one staff member works 00:00 to 23:30 every day. */
async function readyShop(name: string) {
  const shop = await seedShop(name);
  await env.DB.prepare("UPDATE shops SET setup_completed = 1 WHERE id = ?").bind(shop).run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  for (let d = 0; d < 7; d++) {
    await env.DB.prepare(
      `INSERT INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time)
       VALUES (?, ?, ?, ?, '00:00', '23:30')`,
    )
      .bind(crypto.randomUUID(), shop, staff, d)
      .run();
  }
  const auth = { Authorization: `Bearer ${await tokenFor("admin", shop)}` };
  return { shop, staff, service, auth };
}

async function openDay(s: { shop: string; auth: Record<string, string> }) {
  const res = await dispatch("POST", `/booking/shops/${s.shop}/open`, { headers: s.auth, body: {} });
  return { status: res.status, body: (await res.json()) as { date?: string; businessDayId?: string; error?: string } };
}

/** A sale row as the database writes it: created_at from datetime('now'), "YYYY-MM-DD HH:MM:SS" in UTC. */
async function seedSale(shop: string, createdAtUtc: string, totalPence: number): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sales (id, shop_id, subtotal_pence, tip_pence, total_pence, tender_type, status, created_at, completed_at)
     VALUES (?, ?, ?, 0, ?, 'cash', 'completed', ?, ?)`,
  )
    .bind(id, shop, totalPence, totalPence, createdAtUtc, createdAtUtc)
    .run();
  await env.DB.prepare(
    `INSERT INTO sale_items (id, sale_id, shop_id, item_type, name, quantity, unit_price_pence, line_total_pence, is_commissionable, created_at)
     VALUES (?, ?, ?, 'product', 'Pomade', 1, ?, ?, 0, ?)`,
  )
    .bind(crypto.randomUUID(), id, shop, totalPence, totalPence, createdAtUtc)
    .run();
  return id;
}

describe("in British Summer Time, between midnight and 1am London", () => {
  it("opening the day records the shop's date, not UTC's", async () => {
    const s = await readyShop("Day Open BST");
    at(JUST_AFTER_MIDNIGHT_BST);
    const open = await openDay(s);
    expect(open).toMatchObject({ status: 200, body: { date: "2026-07-02" } });
    const row = await env.DB.prepare("SELECT date FROM bw_business_days WHERE shop_id = ?")
      .bind(s.shop)
      .first<{ date: string }>();
    expect(row!.date).toBe("2026-07-02");
  });

  it("a day opened just after midnight is still today at 9am: walk-ins are taken, on that date", async () => {
    const s = await readyShop("Walk-in BST");
    at(JUST_AFTER_MIDNIGHT_BST);
    expect((await openDay(s)).status).toBe(200);

    at(MORNING_BST);
    const res = await dispatch("POST", `/booking/shops/${s.shop}/walk-ins`, {
      headers: s.auth,
      body: { serviceId: s.service, staffId: s.staff, customerName: "Walk In" },
    });
    const body = (await res.json()) as { success: boolean; bookingId?: string; error?: string };
    expect({ status: res.status, error: body.error }).toEqual({ status: 200, error: undefined });
    const row = await env.DB.prepare("SELECT booking_date FROM bookings WHERE id = ?")
      .bind(body.bookingId)
      .first<{ booking_date: string }>();
    expect(row!.booking_date).toBe("2026-07-02");
  });

  it("a counter sale made later that day belongs to the business day opened just after midnight", async () => {
    const s = await readyShop("Sale Day BST");
    at(JUST_AFTER_MIDNIGHT_BST);
    const open = await openDay(s);
    expect(open.status).toBe(200);

    at(MORNING_BST);
    const res = await dispatch("POST", `/booking/shops/${s.shop}/sales`, {
      headers: s.auth,
      body: { tender: "cash", items: [{ type: "service", serviceId: s.service, quantity: 1, staffId: s.staff }] },
    });
    expect(res.status).toBe(200);
    const { sale } = (await res.json()) as { sale: { id: string } };
    const row = await env.DB.prepare("SELECT business_day_id FROM sales WHERE id = ?")
      .bind(sale.id)
      .first<{ business_day_id: string | null }>();
    expect(row!.business_day_id).toBe(open.body.businessDayId);
  });

  it("closing that evening finds the day, and sums the sales of the shop's day", async () => {
    const s = await readyShop("Day Close BST");
    at(JUST_AFTER_MIDNIGHT_BST);
    expect((await openDay(s)).status).toBe(200);

    await seedSale(s.shop, "2026-07-01 22:30:00", 100); // 23:30 London on 1 July: the day before
    await seedSale(s.shop, "2026-07-01 23:30:00", 2_000); // 00:30 London on 2 July
    await seedSale(s.shop, "2026-07-02 21:45:00", 300); // 22:45 London on 2 July
    await seedSale(s.shop, "2026-07-02 23:15:00", 40_000); // 00:15 London on 3 July: the day after

    at(LATE_EVENING_BST);
    const res = await dispatch("POST", `/booking/shops/${s.shop}/close`, { headers: s.auth, body: {} });
    const body = (await res.json()) as { error?: string; summary?: { productsRevenuePence: number } };
    expect({ status: res.status, error: body.error }).toEqual({ status: 200, error: undefined });
    expect(body.summary!.productsRevenuePence).toBe(2_300);
  });

  it("the sales list defaults to the shop's date and lists the shop's day", async () => {
    const s = await readyShop("Sales List BST");
    const before = await seedSale(s.shop, "2026-07-01 22:30:00", 100); // 23:30 London, 1 July
    const after = await seedSale(s.shop, "2026-07-01 23:30:00", 200); // 00:30 London, 2 July
    at(JUST_AFTER_MIDNIGHT_BST);

    const listed = async (query: string) => {
      const res = await dispatch("GET", `/booking/shops/${s.shop}/sales${query}`, { headers: s.auth });
      return ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
    };
    expect(await listed("")).toEqual([after]);
    expect(await listed("?date=2026-07-02")).toEqual([after]);
    expect(await listed("?date=2026-07-01")).toEqual([before]);
  });
});

describe("the sales list, asked for a date that is not on the calendar", () => {
  // Each matches YYYY-MM-DD but names no real day (2026 is not a leap year).
  // Reading the shop's day for one must not throw: that would be a 500 and an
  // Issues email. It is the caller's mistake, a 400.
  it.each(["2026-13-01", "2026-02-30", "2026-02-29", "2026-04-31", "2026-00-10"])(
    "%s answers 400 'date must be YYYY-MM-DD' and logs no error",
    async (date) => {
      const s = await readyShop(`Bad Date ${date}`);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await dispatch("GET", `/booking/shops/${s.shop}/sales?date=${date}`, { headers: s.auth });
        expect({ status: res.status, body: await res.json(), errors: errorSpy.mock.calls.length }).toEqual({
          status: 400,
          body: { success: false, error: "date must be YYYY-MM-DD" },
          errors: 0,
        });
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  // The public slots lookup and booking take a date too, from anyone.
  it.each(["2026-13-01", "2026-02-30", "2026-00-10"])(
    "public slots for %s answer 400 'date must be in YYYY-MM-DD format' and log no error",
    async (date) => {
      const s = await readyShop(`Bad Slots ${date}`);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await dispatch("GET", `/public/shops/${s.shop}/slots?date=${date}&service_id=${s.service}`);
        const text = await res.text();
        expect({ status: res.status, text, errors: errorSpy.mock.calls.length }).toEqual({
          status: 400,
          text: JSON.stringify({ success: false, error: "date must be in YYYY-MM-DD format" }),
          errors: 0,
        });
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  // The booking's date is only a hint for which day's slots to check: a hint
  // that is not a real day is set aside, as one that is not YYYY-MM-DD always
  // was ("not-a-date", the control), and the start is checked against its own
  // day in the shop. Never a 500.
  it.each(["2099-13-01", "2099-02-30", "not-a-date"])(
    "a public booking sent the date hint %s books the start on its own day, and logs no error",
    async (date) => {
      const s = await readyShop(`Bad Booking ${date}`);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const res = await dispatch("POST", "/public/bookings", {
          body: {
            shop_slug: await slugFor(s.shop),
            staff_id: s.staff,
            service_id: s.service,
            date,
            start_time: "2099-07-02T09:00:00.000Z",
            customer_name: "Casey",
            customer_email: "casey@test.local",
          },
        });
        const body = (await res.json()) as { data?: { id: string } };
        const row = body.data
          ? await env.DB.prepare("SELECT booking_date FROM bookings WHERE id = ?")
              .bind(body.data.id)
              .first<{ booking_date: string }>()
          : null;
        expect({ status: res.status, booking_date: row?.booking_date, errors: errorSpy.mock.calls.length }).toEqual({
          status: 201,
          booking_date: "2099-07-02",
          errors: 0,
        });
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("a real leap day is a real date (control)", async () => {
    const s = await readyShop("Leap Day");
    const res = await dispatch("GET", `/booking/shops/${s.shop}/sales?date=2028-02-29`, { headers: s.auth });
    expect(res.status).toBe(200);
  });
});

describe("an online booking that starts between midnight and 1am London in summer", () => {
  // 00:30 London on 2 July 2099 (BST), which is 23:30 UTC on 1 July.
  const START = "2099-07-01T23:30:00.000Z";

  async function book(s: { shop: string; staff: string; service: string }, date?: string) {
    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_slug: await slugFor(s.shop),
        staff_id: s.staff,
        service_id: s.service,
        ...(date ? { date } : {}),
        start_time: START,
        customer_name: "Casey",
        customer_email: "casey@test.local",
      },
    });
    const body = (await res.json()) as { data?: { id: string }; error?: string };
    if (res.status !== 201) return { status: res.status, error: body.error };
    const row = await env.DB.prepare("SELECT booking_date FROM bookings WHERE id = ?")
      .bind(body.data!.id)
      .first<{ booking_date: string }>();
    return { status: res.status, booking_date: row!.booking_date };
  }

  it("is checked against the shop's day and filed under it, when the page sends the date", async () => {
    const s = await readyShop("Online BST dated");
    expect(await book(s, "2099-07-02")).toEqual({ status: 201, booking_date: "2099-07-02" });
  });

  it("is checked against the shop's day and filed under it, when no date is sent", async () => {
    const s = await readyShop("Online BST undated");
    expect(await book(s)).toEqual({ status: 201, booking_date: "2099-07-02" });
  });
});

describe("the clocks changing, and winter (controls)", () => {
  it("in winter (GMT) the shop's day is UTC's day: nothing changes", async () => {
    const s = await readyShop("Day Open GMT");
    at(new Date("2026-11-14T00:30:00Z")); // 00:30 London = 00:30 UTC
    expect(await openDay(s)).toMatchObject({ status: 200, body: { date: "2026-11-14" } });
    const sale = await seedSale(s.shop, "2026-11-14 00:30:00", 100);
    await seedSale(s.shop, "2026-11-13 23:30:00", 100);
    const res = await dispatch("GET", `/booking/shops/${s.shop}/sales`, { headers: s.auth });
    expect(((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual([sale]);
  });

  it("the day the clocks go forward is 23 hours long (29 March 2026)", async () => {
    const s = await readyShop("Clocks Forward");
    const first = await seedSale(s.shop, "2026-03-29 00:30:00", 100); // 00:30 London (GMT)
    const last = await seedSale(s.shop, "2026-03-29 22:30:00", 100); // 23:30 London (BST)
    await seedSale(s.shop, "2026-03-29 23:30:00", 100); // 00:30 London on 30 March
    await seedSale(s.shop, "2026-03-28 23:30:00", 100); // 23:30 London on 28 March
    const res = await dispatch("GET", `/booking/shops/${s.shop}/sales?date=2026-03-29`, { headers: s.auth });
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(ids.sort()).toEqual([first, last].sort());
  });
});

// ─── Source guard ─────────────────────────────────────────────────────────────
// The booking worker's day comes from shopToday and the shop's day window.
// A UTC date taken from an instant ("toISOString().slice(0, 10)") or from a
// stored timestamp ("substr(created_at, 1, 10)") is UTC's day, not the shop's.

const sources = import.meta.glob(["../src/**/*.ts"], { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

const UTC_DAY = [/toISOString\(\)\s*\.slice\(0,\s*10\)/g, /substr\(\s*[\w.]*created_at\s*,\s*1\s*,\s*10\s*\)/g, /\btodayUtcYmd\b/g];

function utcDays(text: string): number {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return UTC_DAY.reduce((n, re) => n + (code.match(re)?.length ?? 0), 0);
}

describe("booking worker source", () => {
  it("the check finds the UTC days it exists to forbid (control)", () => {
    expect(utcDays("const d = new Date().toISOString().slice(0, 10);")).toBe(1);
    expect(utcDays("WHERE substr(sa.created_at, 1, 10) = ?")).toBe(1);
    expect(utcDays("const date = todayUtcYmd();")).toBe(1);
    expect(utcDays("// toISOString().slice(0, 10) was UTC")).toBe(0);
  });

  it("no source file takes a day from UTC", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(20);
    const found = files.filter((f) => utcDays(sources[f]!) > 0).map((f) => `${f} x${utcDays(sources[f]!)}`);
    expect(found).toEqual([]);
  });
});
