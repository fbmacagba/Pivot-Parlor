/** Audit trail Plan 2, Task 3: staff changes, the avatar upload, and staff's
 *  own requests (time off, booking status) record their entry. */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, tokenFor } from "./helpers";
import { adminToken, entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

async function setup() {
  const shopId = await seedShop("Audit Staff Shop");
  const { token } = await adminToken(shopId);
  return { shopId, headers: authHeaders(token), token };
}

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

async function addService(shopId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active)
     VALUES (?, ?, 'Skin fade', 30, 2500, NULL, 1)`,
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function fullRow(id: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM audit_log WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1")
    .bind(id)
    .first<Record<string, unknown>>();
  return row!;
}

describe("staff create / update / delete", () => {
  it("staff create records ids only", async () => {
    const { shopId, headers } = await setup();
    const svc1 = await addService(shopId);
    const svc2 = await addService(shopId);
    const displayName = "Zebediah Quillfeather";
    const email = `zeb-${crypto.randomUUID()}@quill.test`;
    const res = await dispatch("POST", `/api/shops/${shopId}/staff`, {
      headers,
      body: { display_name: displayName, email, bio: "Loves cutting hair", service_ids: [svc1, svc2] },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const created = ((await res.json()) as { data: { id: string; user_id: string; temp_password: string } }).data;
    const [entry] = await entriesFor({ action: "staff.create", shopId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("staff");
    expect(entry!.entity_id).toBe(created.id);
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ is_active: [null, 1] });
    expect(JSON.parse(entry!.details_json as string)).toEqual({
      user_id: created.user_id,
      services: 2,
      temp_password_issued: true,
    });
    expectNoPersonalData(await fullRow(created.id), [displayName, email, created.temp_password, "Loves cutting hair"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("staff create with a supplied password records temp_password_issued false", async () => {
    const { shopId, headers } = await setup();
    const res = await dispatch("POST", `/api/shops/${shopId}/staff`, {
      headers,
      body: { display_name: "Pw Person", email: `pw-${crypto.randomUUID()}@quill.test`, password: `pw-${crypto.randomUUID()}` },
    });
    expect(res.status).toBe(201);
    const [entry] = await entriesFor({ action: "staff.create", shopId });
    expect(JSON.parse(entry!.details_json as string)).toEqual({
      user_id: ((await res.json()) as { data: { user_id: string } }).data.user_id,
      services: 0,
      temp_password_issued: false,
    });
  });

  it("staff create leaves no user row when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const email = `orphan-${crypto.randomUUID()}@quill.test`;
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/staff`, {
        headers,
        body: { display_name: "Orphan Check", email },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = ?").bind(email).first<{ n: number }>();
    expect(users!.n).toBe(0);
    const staffRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(staffRows!.n).toBe(0);
  });

  it("staff update lists changed field names, not values", async () => {
    const { shopId, headers } = await setup();
    const staffId = await seedStaff(shopId);
    const newName = "Marguerite Oakenshield";
    const newBio = "Secret biography text";
    const res = await dispatch("PUT", `/api/shops/${shopId}/staff/${staffId}`, {
      headers,
      body: { display_name: newName, bio: newBio, not_a_column: "x" },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "staff.update", shopId, entityId: staffId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("staff");
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["bio", "display_name"] });
    expectNoPersonalData(await fullRow(staffId), [newName, newBio]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("staff update records the service count when the list is replaced", async () => {
    const { shopId, headers } = await setup();
    const staffId = await seedStaff(shopId);
    const svc = await addService(shopId);
    const res = await dispatch("PUT", `/api/shops/${shopId}/staff/${staffId}`, {
      headers,
      body: { service_ids: [svc] },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "staff.update", shopId, entityId: staffId });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ services: 1 });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_services WHERE staff_id = ?").bind(staffId).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("staff create with a non-array service_ids answers 201 as before and links nothing", async () => {
    const { shopId, headers } = await setup();
    for (const serviceIds of [5, {}, true]) {
      const res = await dispatch("POST", `/api/shops/${shopId}/staff`, {
        headers,
        body: { display_name: "Odd Services", email: `odd-${crypto.randomUUID()}@quill.test`, service_ids: serviceIds },
      });
      expect(res.status, `service_ids ${JSON.stringify(serviceIds)}: ${await res.clone().text()}`).toBe(201);
      const created = ((await res.json()) as { data: { id: string } }).data;
      const [entry] = await entriesFor({ action: "staff.create", shopId, entityId: created.id });
      expect(JSON.parse(entry!.details_json as string).services).toBe(0);
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_services WHERE staff_id = ?").bind(created.id).first<{ n: number }>();
      expect(n!.n).toBe(0);
    }
  });

  it("staff create with a string service_ids fails as before the audit work and leaves no user", async () => {
    // Pins parity, not a wanted contract: the pre-audit handler crashed with a
    // 500 here after creating the user and staff rows; now nothing is written.
    const { shopId, headers } = await setup();
    const email = `str-${crypto.randomUUID()}@quill.test`;
    const res = await dispatch("POST", `/api/shops/${shopId}/staff`, {
      headers,
      body: { display_name: "String Services", email, service_ids: "abc" },
    });
    expect(res.status).toBe(500);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = ?").bind(email).first<{ n: number }>();
    expect(users!.n).toBe(0);
  });

  it("staff create drops null service ids, so the count equals the links written", async () => {
    const { shopId, headers } = await setup();
    const svc = await addService(shopId);
    const res = await dispatch("POST", `/api/shops/${shopId}/staff`, {
      headers,
      body: { display_name: "Null Services", email: `nulls-${crypto.randomUUID()}@quill.test`, service_ids: [svc, null, svc] },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const created = ((await res.json()) as { data: { id: string } }).data;
    const [entry] = await entriesFor({ action: "staff.create", shopId, entityId: created.id });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_services WHERE staff_id = ?").bind(created.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(JSON.parse(entry!.details_json as string).services).toBe(n!.n);
  });

  it("staff update drops null service ids, so the count equals the links written", async () => {
    const { shopId, headers } = await setup();
    const staffId = await seedStaff(shopId);
    const svc = await addService(shopId);
    const res = await dispatch("PUT", `/api/shops/${shopId}/staff/${staffId}`, {
      headers,
      body: { service_ids: [null, svc, svc] },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [entry] = await entriesFor({ action: "staff.update", shopId, entityId: staffId });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_services WHERE staff_id = ?").bind(staffId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(JSON.parse(entry!.details_json as string)).toEqual({ services: n!.n });
  });

  it("staff update with a non-array service_ids fails as before the audit work and changes nothing", async () => {
    // Pins parity, not a wanted contract: the pre-audit handler crashed with a
    // 500 on a truthy non-array (after its own partial writes); this one still
    // answers 500, and now nothing is written.
    const { shopId, headers } = await setup();
    const staffId = await seedStaff(shopId);
    const svc = await addService(shopId);
    await env.DB.prepare("INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)").bind(staffId, svc).run();
    for (const serviceIds of [5, {}, "abc"]) {
      const res = await dispatch("PUT", `/api/shops/${shopId}/staff/${staffId}`, {
        headers,
        body: { display_name: "Should Not Stick", service_ids: serviceIds },
      });
      expect(res.status, `service_ids ${JSON.stringify(serviceIds)}`).toBe(500);
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_services WHERE staff_id = ?").bind(staffId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const row = await env.DB.prepare("SELECT display_name FROM staff WHERE id = ?").bind(staffId).first<{ display_name: string }>();
    expect(row!.display_name).not.toBe("Should Not Stick");
    expect(await entriesFor({ action: "staff.update", shopId, entityId: staffId })).toEqual([]);
  });

  it("staff update changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const staffId = await seedStaff(shopId);
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/staff/${staffId}`, { headers, body: { display_name: "Renamed Person" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT display_name FROM staff WHERE id = ?").bind(staffId).first<{ display_name: string }>();
    expect(row!.display_name).not.toBe("Renamed Person");
  });

  it("staff delete records is_active 1 to 0", async () => {
    const { shopId, headers } = await setup();
    const staffId = await seedStaff(shopId);
    const res = await dispatch("DELETE", `/api/shops/${shopId}/staff/${staffId}`, { headers });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "staff.delete", shopId, entityId: staffId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("staff");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ is_active: [1, 0] });
    const row = await env.DB.prepare("SELECT is_active FROM staff WHERE id = ?").bind(staffId).first<{ is_active: number }>();
    expect(row!.is_active).toBe(0);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("deleting an already inactive member records no change", async () => {
    const { shopId, headers } = await setup();
    const staffId = await seedStaff(shopId);
    await env.DB.prepare("UPDATE staff SET is_active = 0 WHERE id = ?").bind(staffId).run();
    const res = await dispatch("DELETE", `/api/shops/${shopId}/staff/${staffId}`, { headers });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "staff.delete", shopId, entityId: staffId });
    expect(entry!.changes_json).toBeNull();
  });
});

describe("staff avatar", () => {
  async function upload(shopId: string, staffId: string, token: string): Promise<Response> {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])], "me.webp", { type: "image/webp" }));
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request(`https://worker.test/api/shops/${shopId}/staff/${staffId}/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }) as never,
      env as never,
      ctx as never,
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("avatar upload records the field name only", async () => {
    const { shopId, token } = await setup();
    const staffId = await seedStaff(shopId);
    const res = await upload(shopId, staffId, token);
    expect(res.status).toBe(200);
    const { avatarUrl } = (await res.json()) as { avatarUrl: string };
    const entries = await entriesFor({ action: "staff.update", shopId, entityId: staffId });
    // Pattern T: a started entry, then the outcome entry.
    expect(entries.map((e) => e.phase)).toEqual(["started", "outcome"]);
    const entry = entries[1]!;
    expect(entry.outcome).toBe("succeeded");
    expect(entry.entity_type).toBe("staff");
    expect(JSON.parse(entry.details_json as string)).toEqual({ fields: ["avatar_url"] });
    expectNoPersonalData(entry, [avatarUrl]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("avatar upload refuses before the R2 write when the started entry cannot be written", async () => {
    const { shopId, token } = await setup();
    const staffId = await seedStaff(shopId);
    const key = `staff/${shopId}/${staffId}/avatar.webp`;
    const res = await withAuditOff(() => upload(shopId, staffId, token));
    expect(res.status).toBe(503);
    expect(await env.ASSETS.get(key)).toBeNull();
    const row = await env.DB.prepare("SELECT avatar_url FROM staff WHERE id = ?").bind(staffId).first<{ avatar_url: string | null }>();
    expect(row!.avatar_url).toBeNull();
  });
});

describe("staff own requests", () => {
  async function staffSession(shopId: string) {
    const staffId = await seedStaff(shopId);
    const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?").bind(staffId).first<{ user_id: string }>();
    const token = await tokenFor(row!.user_id, "staff", shopId);
    return { staffId, userId: row!.user_id, headers: authHeaders(token) };
  }

  it("time off records the day count, not the dates or reason", async () => {
    const shopId = await seedShop("Audit Time Off Shop");
    const { headers } = await staffSession(shopId);
    const reason = "Wedding of my cousin Priscilla";
    const res = await dispatch("POST", "/api/staff/me/time-off", {
      headers,
      body: { from_date: "2027-03-01", to_date: "2027-03-03", reason },
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    const [entry] = await entriesFor({ action: "staff.time_off.request", shopId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("staff_time_off");
    expect(entry!.entity_id).toBe(id);
    expect(JSON.parse(entry!.details_json as string)).toEqual({ days: 3 });
    expectNoPersonalData(await fullRow(id), [reason, "2027-03-01", "2027-03-03", "Priscilla"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a single-day time off request counts one day", async () => {
    const shopId = await seedShop("Audit Time Off One");
    const { headers } = await staffSession(shopId);
    const res = await dispatch("POST", "/api/staff/me/time-off", {
      headers,
      body: { from_date: "2027-03-01", to_date: "2027-03-01" },
    });
    expect(res.status).toBe(201);
    const [entry] = await entriesFor({ action: "staff.time_off.request", shopId });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ days: 1 });
  });

  it("time off with a rolled-over date (Feb 30) records days null, not an inflated count", async () => {
    const shopId = await seedShop("Audit Time Off Feb30");
    const { headers } = await staffSession(shopId);
    const res = await dispatch("POST", "/api/staff/me/time-off", {
      headers,
      body: { from_date: "2027-02-27", to_date: "2027-02-30" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const [entry] = await entriesFor({ action: "staff.time_off.request", shopId });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ days: null });
  });

  it("time off with an impossible month (13) answers 201 as before and records days null", async () => {
    // Already null before this fix (NaN serialises as null); it guards the
    // date check itself, which must never throw on such a value.
    const shopId = await seedShop("Audit Time Off Month13");
    const { headers } = await staffSession(shopId);
    const res = await dispatch("POST", "/api/staff/me/time-off", {
      headers,
      body: { from_date: "2027-12-30", to_date: "2027-13-01" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const [entry] = await entriesFor({ action: "staff.time_off.request", shopId });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ days: null });
  });

  it("time off across a month end counts calendar days", async () => {
    const shopId = await seedShop("Audit Time Off Month End");
    const { headers } = await staffSession(shopId);
    const res = await dispatch("POST", "/api/staff/me/time-off", {
      headers,
      body: { from_date: "2027-02-27", to_date: "2027-03-02" },
    });
    expect(res.status).toBe(201);
    const [entry] = await entriesFor({ action: "staff.time_off.request", shopId });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ days: 4 });
  });

  it("time off changes nothing when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Time Off Off");
    const { staffId, headers } = await staffSession(shopId);
    const res = await withAuditOff(() =>
      dispatch("POST", "/api/staff/me/time-off", { headers, body: { from_date: "2027-03-01", to_date: "2027-03-02" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_time_off WHERE staff_id = ?").bind(staffId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  async function seedBookingFor(shopId: string, staffId: string, status = "confirmed"): Promise<string> {
    const serviceId = await addService(shopId);
    const id = crypto.randomUUID();
    const start = new Date(Date.now() + 72 * 3_600_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
         booking_date, start_time, end_time, status, amount_pence)
       VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, ?, 2500)`,
    )
      .bind(id, shopId, staffId, serviceId, start.toISOString().slice(0, 10), start.toISOString(), end.toISOString(), status)
      .run();
    return id;
  }

  it("staff booking status records before and after", async () => {
    const shopId = await seedShop("Audit Staff Status");
    const { staffId, headers } = await staffSession(shopId);
    const bookingId = await seedBookingFor(shopId, staffId);
    const res = await dispatch("PUT", `/api/staff/me/bookings/${bookingId}/status`, {
      headers,
      body: { status: "in_progress" },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "booking.status", shopId, entityId: bookingId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("booking");
    expect(entry!.actor_type).toBe("staff");
    expect(entry!.actor_role).toBe("staff");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ status: ["confirmed", "in_progress"] });
    const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(bookingId).first<{ status: string }>();
    expect(row!.status).toBe("in_progress");
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("staff booking status changes nothing when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Staff Status Off");
    const { staffId, headers } = await staffSession(shopId);
    const bookingId = await seedBookingFor(shopId, staffId);
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/staff/me/bookings/${bookingId}/status`, { headers, body: { status: "completed" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(bookingId).first<{ status: string }>();
    expect(row!.status).toBe("confirmed");
  });
});
