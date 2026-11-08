/** Audit trail Plan 2, Task 2: service and schedule changes record their entry
 *  in the same D1 batch as the change. */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff } from "./helpers";
import { adminToken, entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

async function setup() {
  const shopId = await seedShop("Audit Services Shop");
  const { token } = await adminToken(shopId);
  return { shopId, headers: authHeaders(token) };
}

async function addService(shopId: string, price = 2500): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active)
     VALUES (?, ?, 'Skin fade', 30, ?, NULL, 1)`,
  )
    .bind(id, shopId, price)
    .run();
  return id;
}

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

describe("service audit entries", () => {
  it("service create records the new service", async () => {
    const { shopId, headers } = await setup();
    const res = await dispatch("POST", `/api/shops/${shopId}/services`, {
      headers,
      body: { name: "Skin fade", duration_min: 30, price_pence: 2500 },
    });
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { data: { id: string } }).data;
    const [entry] = await entriesFor({ action: "service.create", shopId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("service");
    expect(entry!.entity_id).toBe(created.id);
    expect(JSON.parse(entry!.changes_json as string)).toEqual({
      name: [null, "Skin fade"],
      duration_min: [null, 30],
      price_pence: [null, 2500],
    });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("service update records before and after for changed fields only", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId, 2500);
    const res = await dispatch("PUT", `/api/shops/${shopId}/services/${id}`, {
      headers,
      body: { name: "Skin fade", price_pence: 3000, not_a_column: "x" },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "service.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("service");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ price_pence: [2500, 3000] });
    expect(JSON.parse(entry!.details_json as string).fields).toEqual(["price_pence"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("service delete records is_active 1 to 0", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId);
    const res = await dispatch("DELETE", `/api/shops/${shopId}/services/${id}`, { headers });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "service.delete", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("service");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ is_active: [1, 0] });
    const row = await env.DB.prepare("SELECT is_active FROM services WHERE id = ?").bind(id).first<{ is_active: number }>();
    expect(row!.is_active).toBe(0);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("service products update records the product count", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId);
    const productIds: string[] = [];
    for (const n of ["a", "b"]) {
      const pid = crypto.randomUUID();
      productIds.push(pid);
      await env.DB.prepare(`INSERT INTO products (id, shop_id, name) VALUES (?, ?, ?)`)
        .bind(pid, shopId, `Product ${n}`)
        .run();
    }
    const res = await dispatch("PUT", `/api/shops/${shopId}/services/${id}/products`, {
      headers,
      body: { products: productIds.map((product_id) => ({ product_id, quantity: 2 })) },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [entry] = await entriesFor({ action: "service.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("service_products");
    expect(JSON.parse(entry!.details_json as string)).toEqual({ product_count: 2 });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("deleting an already inactive service records no change", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId);
    await env.DB.prepare("UPDATE services SET is_active = 0 WHERE id = ?").bind(id).run();
    const res = await dispatch("DELETE", `/api/shops/${shopId}/services/${id}`, { headers });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "service.delete", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.changes_json).toBeNull();
  });

  it("service update with is_active true on an active service records no change", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId);
    const res = await dispatch("PUT", `/api/shops/${shopId}/services/${id}`, { headers, body: { is_active: true } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "service.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.changes_json).toBeNull();
    expect(entry!.details_json).toBeNull();
  });

  it("service update with is_active false records 1 to 0", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId);
    const res = await dispatch("PUT", `/api/shops/${shopId}/services/${id}`, { headers, body: { is_active: false } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "service.update", shopId, entityId: id });
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ is_active: [1, 0] });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["is_active"] });
  });

  it("service update with text in duration_min and is_active names the fields, never the text", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId);
    const durationText = "Call Jemima on 07700900456";
    const activeText = "Ask for Bartholomew";
    const res = await dispatch("PUT", `/api/shops/${shopId}/services/${id}`, {
      headers,
      body: { duration_min: durationText, is_active: activeText },
    });
    // The handler writes what it is given, as it always has.
    expect(res.status, await res.clone().text()).toBe(200);
    const [entry] = await entriesFor({ action: "service.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["duration_min", "is_active"] });
    expectNoPersonalData(entry!, [durationText, activeText, "Jemima", "Bartholomew"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("service update with a fractional duration_min names the field only", async () => {
    const { shopId, headers } = await setup();
    const id = await addService(shopId);
    const res = await dispatch("PUT", `/api/shops/${shopId}/services/${id}`, { headers, body: { duration_min: 45.5 } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "service.update", shopId, entityId: id });
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["duration_min"] });
  });

  it("service create with text in duration_min names the field, never the text", async () => {
    const { shopId, headers } = await setup();
    const durationText = "Ring Philippa 07700900789";
    const res = await dispatch("POST", `/api/shops/${shopId}/services`, {
      headers,
      body: { name: "Skin fade", duration_min: durationText, price_pence: 2500 },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const [entry] = await entriesFor({ action: "service.create", shopId });
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ name: [null, "Skin fade"], price_pence: [null, 2500] });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["duration_min"] });
    expectNoPersonalData(entry!, [durationText, "Philippa"]);
  });

  it("a 400 on a real declared route writes no row", async () => {
    const { shopId, headers } = await setup();
    const res = await dispatch("POST", `/api/shops/${shopId}/services`, {
      headers,
      body: { duration_min: 30, price_pence: 2500 },
    });
    expect(res.status).toBe(400);
    const requestId = rid(res);
    expect(requestId).toMatch(/.+/);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE request_id = ?")
      .bind(requestId)
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("service create changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/services`, {
        headers,
        body: { name: "Skin fade", duration_min: 30, price_pence: 2500 },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM services WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("schedule audit entries", () => {
  it("schedule update is one batch with one entry", async () => {
    const { shopId, headers } = await setup();
    const s1 = await seedStaff(shopId);
    const s2 = await seedStaff(shopId);
    const entries = [s1, s2].flatMap((staff_id) =>
      [0, 1].map((day_of_week) => ({ staff_id, day_of_week, start_time: "09:00", end_time: "17:00" })),
    );
    const res = await dispatch("PUT", `/api/shops/${shopId}/schedule`, { headers, body: { entries } });
    expect(res.status).toBe(200);
    const rows = await entriesFor({ action: "schedule.update", shopId });
    expect(rows.length).toBe(1);
    const entry = rows[0]!;
    expect(entry.outcome).toBe("succeeded");
    expect(entry.entity_type).toBe("schedule");
    expect(entry.entity_id).toBe(shopId);
    expect(JSON.parse(entry.details_json as string)).toEqual({
      entries: 4,
      staff_ids: [s1, s2].sort(),
      days_off: 0,
    });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM schedules WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(4);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("schedule update counts days off and reuses existing rows", async () => {
    const { shopId, headers } = await setup();
    const s1 = await seedStaff(shopId);
    const put = (entries: unknown[]) => dispatch("PUT", `/api/shops/${shopId}/schedule`, { headers, body: { entries } });
    await put([{ staff_id: s1, day_of_week: 2, start_time: "09:00", end_time: "17:00" }]);
    const res = await put([
      { staff_id: s1, day_of_week: 2, off: true },
      { staff_id: s1, day_of_week: 3, start_time: "10:00", end_time: "16:00" },
    ]);
    expect(res.status).toBe(200);
    const rows = await entriesFor({ action: "schedule.update", shopId });
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ entries: 1, staff_ids: [s1], days_off: 1 });
    const off = await env.DB.prepare("SELECT is_active FROM schedules WHERE staff_id = ? AND day_of_week = 2")
      .bind(s1)
      .all<{ is_active: number }>();
    expect(off.results.map((r) => r.is_active)).toEqual([0]);
  });

  it("schedule update changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const s1 = await seedStaff(shopId);
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/schedule`, {
        headers,
        body: { entries: [{ staff_id: s1, day_of_week: 0, start_time: "09:00", end_time: "17:00" }] },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM schedules WHERE staff_id = ?").bind(s1).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
