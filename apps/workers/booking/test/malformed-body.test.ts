import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { seedShop, seedStaff, seedScheduleDay, seedService } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";
import { ROUTE_AUDIT } from "../src/audit/registry.js";

/**
 * A request body that is not a JSON object, or a field of the wrong type, is
 * the caller's mistake. A public route must answer it with a 400. It must not
 * answer 500, write an audit row (a 500 on a declared route is recorded as a
 * failed action), or call console.error (Workers Issues emails the owner about
 * every console.error).
 */

let ipSeq = 0;
/** A fresh address per request, so no per-IP rate limit answers 429 in the route's place. */
function nextIp(): string {
  ipSeq += 1;
  return `10.78.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

type Sent = { status: number; body: unknown; rows: string[]; errors: number };

/** One request with a raw body through the real worker; the audit rows it wrote and its console.error calls. */
async function send(method: string, path: string, rawBody: string): Promise<Sent> {
  const last = await env.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request(`https://booking.test${path}`, {
        method,
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
        body: rawBody,
      }) as never,
      env as never,
      ctx as never,
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    const rows = await env.DB.prepare("SELECT action, outcome FROM audit_log WHERE rowid > ? ORDER BY rowid")
      .bind(last!.n)
      .all<{ action: string; outcome: string }>();
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return {
      status: res.status,
      body,
      rows: (rows.results ?? []).map((r) => `${r.action}/${r.outcome}`),
      errors: errorSpy.mock.calls.length,
    };
  } finally {
    errorSpy.mockRestore();
  }
}

// Not JSON at all, an empty body, and JSON that is not an object.
const MALFORMED = ["this is not json {", "", "null", "[]", "42", '"text"'];

describe("a body that is not a JSON object", () => {
  it("every declared mutating route answers it below 500, with no audit row and no console.error", async () => {
    const shopId = await seedShop("Booking Malformed Body Shop");
    const keys = Object.keys(ROUTE_AUDIT).sort();
    expect(keys.length).toBeGreaterThan(10);
    const bad: string[] = [];
    let sent = 0;
    for (const key of keys) {
      const [m, p] = key.split(" ");
      const method = m === "ALL" ? "POST" : m!;
      const path = p!.replace(":shopId", shopId).replace(/:[A-Za-z]+/g, "x").replace("/*", "/x");
      for (const raw of MALFORMED) {
        const r = await send(method, path, raw);
        sent += 1;
        if (r.status >= 500 || r.rows.length > 0 || r.errors > 0) {
          bad.push(`${key} ${JSON.stringify(raw)} -> ${r.status} [${r.rows.join(",")}] console.error x${r.errors}`);
        }
      }
    }
    expect(sent).toBe(keys.length * MALFORMED.length);
    expect(bad).toEqual([]);
  }, 120_000);

  it("POST /public/bookings answers it 400 'Invalid JSON'", async () => {
    const seen: string[] = [];
    for (const raw of MALFORMED) {
      const r = await send("POST", "/public/bookings", raw);
      seen.push(`${JSON.stringify(raw)} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    expect(seen).toEqual(
      MALFORMED.map((raw) => `${JSON.stringify(raw)} -> 400 {"success":false,"error":"Invalid JSON"}`),
    );
  });
});

describe("POST /public/bookings: a field of the wrong type", () => {
  const FUTURE_DATE = "2099-06-15";

  /** A bookable shop and a real free slot, so only the swapped field can make the request fail. */
  async function validBooking(): Promise<Record<string, unknown>> {
    const shop = await seedShop("Booking Wrong Type Shop");
    const staff = await seedStaff(shop);
    const service = await seedService(shop, 30);
    for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const slot = slots.find((s) => s.is_available);
    expect(slot, "the fixture offers a free slot").toBeTruthy();
    return {
      shop_id: shop,
      staff_id: staff,
      service_id: service,
      date: FUTURE_DATE,
      start_time: slot!.start_time,
      customer_name: "Casey",
      customer_email: "casey@test.local",
    };
  }

  async function bookingCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>();
    return row!.n;
  }

  it("the unchanged fixture books (control)", async () => {
    const body = await validBooking();
    const r = await send("POST", "/public/bookings", JSON.stringify({ ...body, customer_phone: null, notes: null }));
    expect(r).toMatchObject({ status: 201, errors: 0 });
  });

  it.each([
    ["staff_id", { staff_id: { id: "x" } }, "shop_id (or shop_slug), staff_id, service_id, customer_name, customer_email and start_time are required"],
    ["service_id", { service_id: ["x"] }, "shop_id (or shop_slug), staff_id, service_id, customer_name, customer_email and start_time are required"],
    ["customer_name", { customer_name: 5 }, "shop_id (or shop_slug), staff_id, service_id, customer_name, customer_email and start_time are required"],
    ["customer_phone", { customer_phone: { n: "0123" } }, "customer_phone must be text"],
    ["notes", { notes: ["x"] }, "notes must be text"],
    ["date", { date: 20990615 }, "date must be text"],
  ])("%s answers 400 and books nothing", async (_field, swap, error) => {
    const body = { ...(await validBooking()), ...swap };
    const before = await bookingCount();
    const r = await send("POST", "/public/bookings", JSON.stringify(body));
    expect(r).toMatchObject({ status: 400, body: { success: false, error }, rows: [], errors: 0 });
    expect(await bookingCount()).toBe(before);
  });
});
