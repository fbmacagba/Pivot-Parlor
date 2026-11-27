/**
 * Server halves of the 2026-11 dashboard audit fixes:
 *  - the owner's bookings list honours date_from / date_to / limit (it used to
 *    ignore the dates and return the oldest 200);
 *  - deactivated staff, services and products can be listed and restored (the
 *    lists only ever returned active rows, so nothing could be brought back);
 *  - a staff member's "today" filter is today only;
 *  - a schedule day must end after it starts;
 *  - one site generation per shop at a time.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

async function seedService(shopId: string, name = "Cut", active = 1): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, ?, 30, 2500, ?)",
  )
    .bind(id, shopId, name, active)
    .run();
  return id;
}

async function seedBooking(shopId: string, staffId: string, serviceId: string, date: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, 'confirmed', 2500)`,
  )
    .bind(id, shopId, staffId, serviceId, date, `${date}T09:00:00.000Z`, `${date}T09:30:00.000Z`)
    .run();
  return id;
}

async function adminToken(shopId: string): Promise<string> {
  return tokenFor(await seedUser("admin", shopId), "admin", shopId);
}

async function staffToken(staffId: string, shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?").bind(staffId).first<{ user_id: string }>();
  return tokenFor(row!.user_id, "staff", shopId);
}

async function listIds(path: string, token?: string): Promise<string[]> {
  const res = await dispatch("GET", path, token ? { headers: authHeaders(token) } : {});
  expect(res.status).toBe(200);
  const { data } = await res.json<{ data: Array<{ id: string }> }>();
  return data.map((row) => row.id);
}

describe("owner bookings list", () => {
  it("returns only the days inside date_from and date_to, inclusive", async () => {
    const shopId = await seedShop("range");
    const staffId = await seedStaff(shopId);
    const serviceId = await seedService(shopId);
    const before = await seedBooking(shopId, staffId, serviceId, "2026-06-30");
    const first = await seedBooking(shopId, staffId, serviceId, "2026-07-01");
    const last = await seedBooking(shopId, staffId, serviceId, "2026-07-31");
    const after = await seedBooking(shopId, staffId, serviceId, "2026-08-01");
    const token = await adminToken(shopId);

    const inJuly = await listIds(`/api/shops/${shopId}/bookings?date_from=2026-07-01&date_to=2026-07-31`, token);
    expect(inJuly.sort()).toEqual([first, last].sort());

    const fromJuly = await listIds(`/api/shops/${shopId}/bookings?date_from=2026-07-01`, token);
    expect(fromJuly).not.toContain(before);
    expect(fromJuly).toContain(after);
  });

  it("ignores a bound that is not a date, and honours limit and offset", async () => {
    const shopId = await seedShop("limit");
    const staffId = await seedStaff(shopId);
    const serviceId = await seedService(shopId);
    const a = await seedBooking(shopId, staffId, serviceId, "2026-07-01");
    const b = await seedBooking(shopId, staffId, serviceId, "2026-07-02");
    const c = await seedBooking(shopId, staffId, serviceId, "2026-07-03");
    const token = await adminToken(shopId);

    expect(await listIds(`/api/shops/${shopId}/bookings?date_from=yesterday`, token)).toEqual([a, b, c]);
    expect(await listIds(`/api/shops/${shopId}/bookings?limit=2`, token)).toEqual([a, b]);
    expect(await listIds(`/api/shops/${shopId}/bookings?limit=2&offset=2`, token)).toEqual([c]);
  });
});

describe("deactivated rows can be found and restored", () => {
  it("staff: listed only with include_inactive, restored by is_active 1", async () => {
    const shopId = await seedShop("staff-restore");
    const kept = await seedStaff(shopId);
    const gone = await seedStaff(shopId);
    const token = await adminToken(shopId);

    const del = await dispatch("DELETE", `/api/shops/${shopId}/staff/${gone}`, { headers: authHeaders(token) });
    expect(del.status).toBe(200);

    expect(await listIds(`/api/shops/${shopId}/staff`, token)).toEqual([kept]);
    expect((await listIds(`/api/shops/${shopId}/staff?include_inactive=1`, token)).sort()).toEqual([kept, gone].sort());

    const restore = await dispatch("PUT", `/api/shops/${shopId}/staff/${gone}`, {
      headers: authHeaders(token),
      body: { is_active: 1 },
    });
    expect(restore.status).toBe(200);
    expect((await listIds(`/api/shops/${shopId}/staff`, token)).sort()).toEqual([kept, gone].sort());
  });

  it("services: inactive ones go to the shop's own admin only, never the public", async () => {
    const shopId = await seedShop("svc-restore");
    const active = await seedService(shopId, "Cut", 1);
    const inactive = await seedService(shopId, "Old cut", 0);
    const owner = await adminToken(shopId);
    const otherShop = await seedShop("svc-other");
    const stranger = await adminToken(otherShop);

    expect(await listIds(`/api/shops/${shopId}/services`)).toEqual([active]);
    expect(await listIds(`/api/shops/${shopId}/services?include_inactive=1`)).toEqual([active]);
    expect(await listIds(`/api/shops/${shopId}/services?include_inactive=1`, stranger)).toEqual([active]);
    expect((await listIds(`/api/shops/${shopId}/services?include_inactive=1`, owner)).sort()).toEqual(
      [active, inactive].sort(),
    );
  });

  it("products: listed only with include_inactive", async () => {
    const shopId = await seedShop("prod-restore");
    const token = await adminToken(shopId);
    const create = async (name: string) => {
      const res = await dispatch("POST", `/api/shops/${shopId}/products`, {
        headers: authHeaders(token),
        body: { name, price_pence: 1200 },
      });
      expect(res.status).toBeLessThan(300);
      const { data } = await res.json<{ data: { id: string } }>();
      return data.id;
    };
    const kept = await create("Pomade");
    const gone = await create("Old wax");
    const del = await dispatch("DELETE", `/api/shops/${shopId}/products/${gone}`, { headers: authHeaders(token) });
    expect(del.status).toBe(200);

    expect(await listIds(`/api/shops/${shopId}/products`, token)).toEqual([kept]);
    expect((await listIds(`/api/shops/${shopId}/products?include_inactive=1`, token)).sort()).toEqual(
      [kept, gone].sort(),
    );
  });
});

describe("a staff member's own bookings", () => {
  it("filter=today is today only, where upcoming also holds later days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-02T08:00:00Z"));
    const shopId = await seedShop("today");
    const staffId = await seedStaff(shopId);
    const serviceId = await seedService(shopId);
    const today = await seedBooking(shopId, staffId, serviceId, "2026-07-02");
    const tomorrow = await seedBooking(shopId, staffId, serviceId, "2026-07-03");
    const token = await staffToken(staffId, shopId);

    expect(await listIds("/api/staff/me/bookings?filter=today", token)).toEqual([today]);
    expect(await listIds("/api/staff/me/bookings?filter=upcoming", token)).toEqual([today, tomorrow]);
  });
});

describe("schedule", () => {
  it("refuses a working day that ends before it starts, and writes nothing", async () => {
    const shopId = await seedShop("sched");
    const staffId = await seedStaff(shopId);
    const token = await adminToken(shopId);

    const res = await dispatch("PUT", `/api/shops/${shopId}/schedule`, {
      headers: authHeaders(token),
      body: {
        entries: [
          { staff_id: staffId, day_of_week: 1, start_time: "09:00", end_time: "17:00" },
          { staff_id: staffId, day_of_week: 2, start_time: "17:00", end_time: "09:00" },
        ],
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("A working day must end after it starts.");
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM schedules WHERE staff_id = ?")
      .bind(staffId)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});

describe("walk-in queue, staff side", () => {
  it("adds a walk-in by hand and records it without personal data", async () => {
    const shopId = await seedShop("walkin-add");
    const token = await adminToken(shopId);
    const res = await dispatch("POST", `/api/shops/${shopId}/walkin`, {
      headers: authHeaders(token),
      body: { name: "Desmond Counter", service: "Fade" },
    });
    expect(res.status).toBe(201);
    const { data } = await res.json<{ data: { id: string; position: number } }>();
    expect(data.position).toBe(1);
    expect(await listIds(`/api/shops/${shopId}/walkin`, token)).toEqual([data.id]);

    const entry = await env.DB.prepare(
      "SELECT * FROM audit_log WHERE action = 'walkin.join' AND entity_id = ?",
    )
      .bind(data.id)
      .first<Record<string, unknown>>();
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry)).not.toContain("Desmond");
  });

  it("needs a name, and refuses another shop's admin", async () => {
    const shopId = await seedShop("walkin-guard");
    const token = await adminToken(shopId);
    const empty = await dispatch("POST", `/api/shops/${shopId}/walkin`, { headers: authHeaders(token), body: {} });
    expect(empty.status).toBe(400);
    const stranger = await adminToken(await seedShop("walkin-other"));
    const refused = await dispatch("POST", `/api/shops/${shopId}/walkin`, {
      headers: authHeaders(stranger),
      body: { name: "X" },
    });
    expect(refused.status).toBe(403);
  });

  it("lists a skipped entry only with include_skipped, and it can go back to waiting", async () => {
    const shopId = await seedShop("walkin-skip");
    const token = await adminToken(shopId);
    const add = await dispatch("POST", `/api/shops/${shopId}/walkin`, {
      headers: authHeaders(token),
      body: { name: "Skipped Sam" },
    });
    const { data } = await add.json<{ data: { id: string } }>();
    const skip = await dispatch("PATCH", `/api/shops/${shopId}/walkin/${data.id}`, {
      headers: authHeaders(token),
      body: { status: "skipped" },
    });
    expect(skip.status).toBe(200);

    expect(await listIds(`/api/shops/${shopId}/walkin`, token)).toEqual([]);
    expect(await listIds(`/api/shops/${shopId}/walkin?include_skipped=1`, token)).toEqual([data.id]);

    const back = await dispatch("PATCH", `/api/shops/${shopId}/walkin/${data.id}`, {
      headers: authHeaders(token),
      body: { status: "waiting" },
    });
    expect(back.status).toBe(200);
    expect(await listIds(`/api/shops/${shopId}/walkin`, token)).toEqual([data.id]);
  });
});

describe("site generation", () => {
  async function seedJob(shopId: string, status: string, updatedAt: string): Promise<string> {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO generation_jobs (id, shop_id, status, stage, created_at, updated_at) VALUES (?, ?, ?, 'research', ?, ?)",
    )
      .bind(id, shopId, status, updatedAt, updatedAt)
      .run();
    return id;
  }

  it("refuses a second run while one is going, and names the running job", async () => {
    const shopId = await seedShop("gen-busy");
    const token = await tokenFor(await seedUser("developer", null), "developer", null);
    const running = await seedJob(shopId, "queued", new Date().toISOString());

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: {},
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ code: string; data: { job_id: string } }>();
    expect(body.code).toBe("generation_in_progress");
    expect(body.data.job_id).toBe(running);
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE shop_id = ?")
      .bind(shopId)
      .first<{ n: number }>();
    expect(jobs!.n).toBe(1);
  });

  it("does not let a finished, failed or long-stalled job block a new run", async () => {
    const shopId = await seedShop("gen-free");
    const token = await tokenFor(await seedUser("developer", null), "developer", null);
    const now = new Date().toISOString();
    await seedJob(shopId, "complete", now);
    await seedJob(shopId, "failed", now);
    await seedJob(shopId, "queued", new Date(Date.now() - 31 * 60 * 1000).toISOString());

    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: authHeaders(token),
      body: {},
    });
    expect(res.status).not.toBe(409);
  });
});
