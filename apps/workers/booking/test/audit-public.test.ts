import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedScheduleDay, seedService, seedShop, seedStaff, slugFor } from "./helpers";
import { dispatch } from "./request";
import { entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";
import { getAvailableSlots } from "../src/services/slots";
import { sweepExpiredDepositBookings } from "../src/services/deposit-sweep";

const REFUSAL = { success: false, error: "Could not record this action; nothing was changed." };
const IP = { "CF-Connecting-IP": "203.0.113.7" };
const FUTURE_DATE = "2099-10-12";
const customer = {
  customer_name: "Quentin Quill",
  customer_email: "quentin.quill@test.local",
  customer_phone: "07700900123",
  notes: "please use the quiet chair",
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function setupShop(opts: { deposits: boolean; shopName?: string; serviceName?: string }) {
  const shop = await seedShop(opts.shopName ?? "Audit Public Shop");
  if (opts.deposits) {
    await env.DB.prepare(
      "UPDATE shops SET stripe_connect_account_id = 'acct_ap1', stripe_connect_onboarded = 1 WHERE id = ?"
    )
      .bind(shop)
      .run();
    await env.DB.prepare(
      "INSERT INTO shop_settings (shop_id, deposits_enabled, deposit_percent, deposit_min_pence) VALUES (?, 1, 50, 500)"
    )
      .bind(shop)
      .run();
  }
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  if (opts.serviceName) {
    await env.DB.prepare("UPDATE services SET name = ? WHERE id = ?").bind(opts.serviceName, service).run();
  }
  for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
  return { shop, staff, service };
}

async function book(
  s: { shop: string; staff: string; service: string },
  slotIndex = 0,
  who: Record<string, string> = customer
): Promise<Response> {
  const slots = await getAvailableSlots(s.shop, s.staff, FUTURE_DATE, 30, env.DB, env.KV);
  const free = slots.filter((x) => x.is_available);
  return dispatch("POST", "/public/bookings", {
    headers: IP,
    body: {
      shop_slug: await slugFor(s.shop),
      staff_id: s.staff,
      service_id: s.service,
      date: FUTURE_DATE,
      start_time: free[slotIndex]!.start_time,
      ...who,
    },
  });
}

async function bookedId(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const r = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return r?.status;
}

async function age(id: string, iso = "2000-01-01T00:00:00.000Z"): Promise<void> {
  await env.DB.prepare("UPDATE bw_booking_state SET updated_at = ? WHERE booking_id = ?").bind(iso, id).run();
}

describe("public booking audit", () => {
  it("a free public booking records booking.create as anonymous", async () => {
    const s = await setupShop({ deposits: false, shopName: "Quillside Barbers" });
    const res = await book(s);
    const id = await bookedId(res);
    const rows = await entriesFor({ action: "booking.create", shopId: s.shop, entityId: id });
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows.find((r) => r.phase === "outcome")!;
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "anonymous",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: id,
      worker: "pivot-parlor-booking",
    });
    expect(outcome.ip_ref, "ip_ref must be set from CF-Connecting-IP").toBeTruthy();
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: [null, "pending"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ channel: "online", deposit_required: false });
    expectNoPersonalData(outcome, [
      customer.customer_name,
      customer.customer_email,
      customer.customer_phone,
      customer.notes,
      "Quillside Barbers",
    ]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("a deposit booking records deposit_required and never the Checkout URL", async () => {
    const s = await setupShop({ deposits: true });
    const id = await bookedId(await book(s));
    const outcome = (await entriesFor({ action: "booking.create", entityId: id })).find((r) => r.phase === "outcome")!;
    expect(outcome.outcome).toBe("succeeded");
    expect(JSON.parse(outcome.details_json as string)).toEqual({ channel: "online", deposit_required: true });
    expectNoPersonalData(outcome, [`cs_idem_deposit:${id}`, `https://checkout.stripe.com/c/pay/cs_idem_deposit:${id}`]);
  });

  it("a deposit booking whose session fails records failed", async () => {
    const s = await setupShop({ deposits: true, serviceName: "failcut" });
    const res = await book(s);
    expect(res.status).toBe(502);
    const rows = await entriesFor({ action: "booking.create", shopId: s.shop });
    const outcomes = rows.filter((r) => r.phase === "outcome");
    expect(outcomes, "exactly one outcome row").toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: "failed", reason: "HTTP 502" });
    expect(rows.filter((r) => r.outcome === "succeeded")).toHaveLength(0);
    const booking = await env.DB.prepare("SELECT id, status FROM bookings WHERE shop_id = ?")
      .bind(s.shop)
      .first<{ id: string; status: string }>();
    expect(booking?.status).toBe("cancelled");
  });

  it("the deposit Checkout product name carries no dash", async () => {
    const s = await setupShop({ deposits: true, shopName: "Nameplate Cuts" });
    const realFetch = globalThis.fetch;
    const forms: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith("/v1/checkout/sessions")) forms.push(String(init?.body ?? ""));
      return realFetch(input as never, init as never);
    });
    await bookedId(await book(s));
    expect(forms).toHaveLength(1);
    const name = new URLSearchParams(forms[0]!).get("line_items[0][price_data][product_data][name]");
    expect(name).toBe("Booking deposit: Cut at Nameplate Cuts");
    expect(name).not.toMatch(/[–—]/);
  });

  it("answers 503 and stores no booking when the entry cannot be written", async () => {
    const s = await setupShop({ deposits: false });
    const email = `refused-${crypto.randomUUID().slice(0, 8)}@test.local`;
    const res = await withAuditOff(() => book(s, 0, { ...customer, customer_email: email }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE customer_email = ?")
      .bind(email)
      .first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });
});

describe("abandon audit", () => {
  it("abandon records booking.cancel as anonymous with the status change", async () => {
    const s = await setupShop({ deposits: true });
    const id = await bookedId(await book(s));
    const res = await dispatch("POST", `/public/bookings/${id}/abandon`, { headers: IP });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await statusOf(id)).toBe("cancelled");
    const rows = await entriesFor({ action: "booking.cancel", entityId: id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "succeeded",
      actor_type: "anonymous",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: id,
    });
    expect(rows[0]!.ip_ref).toBeTruthy();
    expect(JSON.parse(rows[0]!.changes_json as string)).toEqual({ status: ["pending", "cancelled"] });
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ reason: "abandoned" });
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("abandon after the sweep cancelled records refused, not a second cancel", async () => {
    const s = await setupShop({ deposits: true });
    const id = await bookedId(await book(s));
    await age(id);
    expect(await sweepExpiredDepositBookings(env.DB)).toBe(1);
    const res = await dispatch("POST", `/public/bookings/${id}/abandon`, { headers: IP });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const rows = await entriesFor({ action: "booking.cancel", entityId: id });
    expect(rows.map((r) => [r.outcome, r.actor_type, r.via])).toEqual([
      ["succeeded", "system", "cron"],
      ["refused", "anonymous", "api"],
    ]);
    expect(rows[1]).toMatchObject({ reason: "not_pending", shop_id: s.shop });
    expect(rows[1]!.changes_json).toBeNull();
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("abandon fails closed and cancels nothing when the entry cannot be written", async () => {
    const s = await setupShop({ deposits: true });
    const id = await bookedId(await book(s));
    // The entry prepares (the table is only missing at commit), so the guarded
    // batch itself fails: the original error propagates (Plan 1 Ruling 9) and
    // the cancel rolled back with it.
    const res = await withAuditOff(() => dispatch("POST", `/public/bookings/${id}/abandon`, { headers: IP }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await statusOf(id)).toBe("pending");
    const tx = await env.DB.prepare("SELECT status FROM bw_transactions WHERE booking_id = ? AND type = 'deposit'")
      .bind(id)
      .first<{ status: string }>();
    expect(tx?.status).toBe("pending");
  });
});

describe("deposit sweep audit", () => {
  it("the sweep records a cancel per expired booking as system via cron", async () => {
    const s = await setupShop({ deposits: true });
    const a = await bookedId(await book(s, 0));
    const b = await bookedId(await book(s, 1));
    await age(a);
    await age(b);
    expect(await sweepExpiredDepositBookings(env.DB)).toBe(2);
    for (const id of [a, b]) {
      expect(await statusOf(id)).toBe("cancelled");
      const rows = await entriesFor({ action: "booking.cancel", entityId: id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "succeeded",
        actor_type: "system",
        via: "cron",
        shop_id: s.shop,
        entity_type: "booking",
      });
      expect(JSON.parse(rows[0]!.changes_json as string)).toEqual({ status: ["pending", "cancelled"] });
      expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ reason: "deposit_expired" });
    }
  });

  it("the sweep skips a booking that stopped being pending and carries on", async () => {
    const s = await setupShop({ deposits: true });
    const first = await bookedId(await book(s, 0));
    const second = await bookedId(await book(s, 1));
    // The sweep drains oldest first, so `first` is booking 1's batch.
    await age(first, "2000-01-01T00:00:00.000Z");
    await age(second, "2000-01-02T00:00:00.000Z");

    let fired = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await target
                .prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?")
                .bind(first)
                .run();
            }
            return target.batch(stmts);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof env.DB;

    const n = await sweepExpiredDepositBookings(db);
    expect(fired, "the sweep never reached a batch").toBe(true);
    expect(n).toBe(1);
    expect(await statusOf(first)).toBe("confirmed");
    expect(await statusOf(second)).toBe("cancelled");
    expect(await entriesFor({ action: "booking.cancel", entityId: first })).toHaveLength(0);
    expect(await entriesFor({ action: "booking.cancel", entityId: second })).toHaveLength(1);
    // The lost race left the deposit transaction pending: the rolled-back batch changed nothing.
    const tx = await env.DB.prepare("SELECT status FROM bw_transactions WHERE booking_id = ? AND type = 'deposit'")
      .bind(first)
      .first<{ status: string }>();
    expect(tx?.status).toBe("pending");
  });
});
