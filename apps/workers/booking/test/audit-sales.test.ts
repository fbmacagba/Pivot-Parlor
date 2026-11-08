import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { seedProduct, seedService, seedShop, seedStaff, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

const REFUSAL = { success: false, error: "Could not record this action; nothing was changed." };
const SHOP_NAME = "Till Audit Shop";
const WHO = { name: "Rosalind Quartz", email: "rosalind.quartz@test.local", note: "ask about the beard oil" };

/** `dispatch` with a substituted env (e.g. a Proxy over DB). */
async function dispatchWith(
  testEnv: typeof env,
  method: string,
  path: string,
  opts: { headers: Record<string, string>; body: unknown }
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { ...opts.headers, "Content-Type": "application/json" },
    body: JSON.stringify(opts.body),
  };
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://booking.test${path}`, init) as never, testEnv as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

async function authed(role: string, shop: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await tokenFor(role, shop)}` };
}

interface Till {
  shop: string;
  staff: string;
  service: string;
  product: string;
}

/** commission 10% services, 20% retail. Service 2500, product 1000 (stock 5). */
async function setup(name = SHOP_NAME, stock = 5): Promise<Till> {
  const shop = await seedShop(name);
  await env.DB.prepare(
    "UPDATE shops SET stripe_connect_account_id = 'acct_till1', commission_rate = 0.10, retail_commission_rate = 0.20 WHERE id = ?"
  )
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop);
  const product = await seedProduct(shop, { retailPence: 1000, costPence: 300, stock });
  return { shop, staff, service, product };
}

async function stockQty(t: Till): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL"
  )
    .bind(t.shop, t.product)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

function saleBody(t: Till, tender: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tender,
    items: [
      { type: "service", serviceId: t.service, quantity: 1, staffId: t.staff },
      { type: "product", productId: t.product, quantity: 2, staffId: t.staff },
    ],
    ...extra,
  };
}

const ring = async (t: Till, body: Record<string, unknown>) =>
  dispatch("POST", `/booking/shops/${t.shop}/sales`, { headers: await authed("admin", t.shop), body });

async function ringOk(t: Till, tender = "cash", extra: Record<string, unknown> = {}): Promise<string> {
  const res = await ring(t, saleBody(t, tender, extra));
  expect(res.status).toBe(200);
  return ((await res.json()) as { sale: { id: string } }).sale.id;
}

async function productItem(saleId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM sale_items WHERE sale_id = ? AND item_type = 'product'")
    .bind(saleId)
    .first<{ id: string }>();
  return row!.id;
}

async function returnedQty(itemId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT returned_quantity AS q FROM sale_items WHERE id = ?")
    .bind(itemId)
    .first<{ q: number }>();
  return Number(row?.q);
}

async function saleCount(shop: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM sales WHERE shop_id = ?").bind(shop).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

async function saleStatus(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM sales WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

async function outcomeOf(action: string, shop: string, entityId: string): Promise<Record<string, unknown>> {
  const rows = await entriesFor({ action, shopId: shop, entityId });
  expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
  return rows[1]!;
}

const REASON = "customer said the pomade smelled odd";

const refund = async (t: Till, saleId: string, itemId: string, quantity: number) =>
  dispatch("POST", `/booking/shops/${t.shop}/sales/${saleId}/refund`, {
    headers: await authed("admin", t.shop),
    body: { lines: [{ sale_item_id: itemId, quantity }], reason: REASON },
  });

/** A Stripe sale made refundable: completed, with a settled PaymentIntent. */
async function settleStripe(saleId: string, piId: string): Promise<void> {
  await env.DB.prepare("UPDATE sales SET status = 'completed', stripe_payment_intent_id = ? WHERE id = ?")
    .bind(piId, saleId)
    .run();
}

const STRIPE_URLS = { success_url: "https://shop.test/done", cancel_url: "https://shop.test/cancel" };

describe("sale audit", () => {
  it("records pos.sale for a cash sale with integers and the tender only", async () => {
    const t = await setup();
    const res = await ring(
      t,
      saleBody(t, "cash", { customer_name: WHO.name, customer_email: WHO.email, note: WHO.note })
    );
    expect(res.status).toBe(200);
    const saleId = ((await res.json()) as { sale: { id: string } }).sale.id;
    const outcome = await outcomeOf("pos.sale", t.shop, saleId);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      shop_id: t.shop,
      entity_type: "sale",
      entity_id: saleId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: [null, "completed"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ tender: "cash", lines: 2, total_pence: 4500 });
    for (const row of await entriesFor({ action: "pos.sale", shopId: t.shop })) {
      expectNoPersonalData(row, [WHO.name, WHO.email, WHO.note, SHOP_NAME, "Pomade", "Cut"]);
    }
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("records pos.sale for a Stripe sale as pending, without the Checkout URL or session id", async () => {
    const t = await setup();
    const res = await ring(t, saleBody(t, "stripe", STRIPE_URLS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sale: { id: string; payment_url: string } };
    const session = await env.DB.prepare("SELECT stripe_checkout_session_id AS id FROM sales WHERE id = ?")
      .bind(body.sale.id)
      .first<{ id: string }>();
    expect(body.sale.payment_url, "the fake Stripe returned no Checkout URL to look for").toMatch(/.+/);
    expect(session?.id, "the sale has no Checkout Session id to look for").toMatch(/.+/);
    const outcome = await outcomeOf("pos.sale", t.shop, body.sale.id);
    expect(outcome.outcome).toBe("succeeded");
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: [null, "pending"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ tender: "stripe", lines: 2, total_pence: 4500 });
    for (const row of await entriesFor({ action: "pos.sale", shopId: t.shop })) {
      expectNoPersonalData(row, [body.sale.payment_url, session!.id, SHOP_NAME]);
    }
  });

  it("a sale whose Stripe session fails records failed, voids the sale and returns the stock", async () => {
    // The fake Stripe fails when the form body says "fail"; the shop name is in it.
    const t = await setup("failing till shop");
    const res = await ring(t, saleBody(t, "stripe", STRIPE_URLS));
    expect(res.status).toBe(502);
    const sale = await env.DB.prepare("SELECT id, status FROM sales WHERE shop_id = ?")
      .bind(t.shop)
      .first<{ id: string; status: string }>();
    expect(sale?.status).toBe("voided");
    expect(await stockQty(t)).toBe(5);
    const outcome = await outcomeOf("pos.sale", t.shop, sale!.id);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "HTTP 502" });
    expect(outcome.changes_json).toBeNull();
  });

  it("a sale that loses the stock claim records refused and changes nothing", async () => {
    const t = await setup(SHOP_NAME, 1);
    const res = await ring(t, saleBody(t, "cash"));
    expect(res.status).toBe(400);
    expect(await saleCount(t.shop)).toBe(0);
    expect(await stockQty(t)).toBe(1);
    const rows = await env.DB.prepare(
      "SELECT outcome, reason, changes_json FROM audit_log WHERE action = 'pos.sale' AND shop_id = ? AND phase = 'outcome'"
    )
      .bind(t.shop)
      .all<{ outcome: string; reason: string; changes_json: string | null }>();
    expect(rows.results).toEqual([{ outcome: "refused", reason: "HTTP 400", changes_json: null }]);
  });

  it("answers 503, creates no sale and leaves stock unchanged when the entry cannot be written", async () => {
    const t = await setup();
    const res = await withAuditOff(() => ring(t, saleBody(t, "cash")));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await saleCount(t.shop)).toBe(0);
    expect(await stockQty(t)).toBe(5);
  });
});

describe("refund audit", () => {
  it("records payment.refund.issue for a cash refund", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const item = await productItem(saleId);
    const res = await refund(t, saleId, item, 1);
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("payment.refund.issue", t.shop, saleId);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      shop_id: t.shop,
      entity_type: "sale",
      entity_id: saleId,
    });
    expect(outcome.changes_json).toBeNull();
    expect(JSON.parse(outcome.details_json as string)).toEqual({ lines: 1, refund_pence: 1000, via_stripe: false });
    expectNoPersonalData(outcome, [SHOP_NAME, "Pomade", REASON]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("records via_stripe true for a Stripe refund, without the PaymentIntent or refund id", async () => {
    const t = await setup();
    const saleId = await ringOk(t, "stripe", STRIPE_URLS);
    await settleStripe(saleId, "pi_till_settled_1");
    const res = await refund(t, saleId, await productItem(saleId), 1);
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("payment.refund.issue", t.shop, saleId);
    expect(JSON.parse(outcome.details_json as string)).toEqual({ lines: 1, refund_pence: 1000, via_stripe: true });
    const ret = await env.DB.prepare("SELECT stripe_refund_id AS id FROM sale_returns WHERE sale_id = ?")
      .bind(saleId)
      .first<{ id: string }>();
    expect(ret?.id, "the return has no Stripe refund id to look for").toMatch(/.+/);
    expectNoPersonalData(outcome, ["pi_till_settled_1", ret!.id, REASON]);
  });

  it("a second full refund records nothing", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const item = await productItem(saleId);
    expect((await refund(t, saleId, item, 2)).status).toBe(200);
    const before = (await entriesFor({ action: "payment.refund.issue", shopId: t.shop })).length;
    expect(before).toBe(2);
    const again = await refund(t, saleId, item, 2);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ success: false, error: "Invalid quantity: 0 returnable on that line" });
    expect((await entriesFor({ action: "payment.refund.issue", shopId: t.shop })).length).toBe(before);
  });

  it("a refund that loses the claim race records refused", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const item = await productItem(saleId);
    // Under run() the started entry is itself a DB.batch(), so the route's
    // FIRST batch is the started write and the return claim is the SECOND.
    // A competing refund takes the whole line just before the claim batch.
    let calls = 0;
    let fired = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            calls += 1;
            if (calls === 2 && !fired) {
              fired = true;
              await target.prepare("UPDATE sale_items SET returned_quantity = quantity WHERE id = ?").bind(item).run();
            }
            return target.batch(stmts);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof env.DB;
    const res = await dispatchWith(
      { ...env, DB: db },
      "POST",
      `/booking/shops/${t.shop}/sales/${saleId}/refund`,
      { headers: await authed("admin", t.shop), body: { lines: [{ sale_item_id: item, quantity: 1 }], reason: REASON } }
    );
    expect(fired, "the second batch never ran, so the race was never staged").toBe(true);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: "Another refund touched this sale. Reload and try again.",
    });
    // Pins the ordering assumption: the started row exists, so the claim was
    // the second batch. If run() ever reorders, this fails instead of passing vacuously.
    const outcome = await outcomeOf("payment.refund.issue", t.shop, saleId);
    expect(outcome).toMatchObject({ outcome: "refused", reason: "HTTP 409" });
    expect(outcome.details_json).toBeNull();
    expect(await returnedQty(item)).toBe(2);
  });

  it("a refund whose Stripe call fails records failed and returns the stock claim", async () => {
    const t = await setup();
    const saleId = await ringOk(t, "stripe", STRIPE_URLS);
    await settleStripe(saleId, "pi_fail_refund");
    const item = await productItem(saleId);
    const res = await refund(t, saleId, item, 1);
    expect(res.status).toBe(502);
    const outcome = await outcomeOf("payment.refund.issue", t.shop, saleId);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "HTTP 502" });
    expect(outcome.details_json).toBeNull();
    expect(await returnedQty(item)).toBe(0);
    expectNoPersonalData(outcome, ["pi_fail_refund", REASON]);
  });

  it("uses the dash-free copy for the two refund errors", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const item = await productItem(saleId);
    const bad = await refund(t, saleId, item, 3);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ success: false, error: "Invalid quantity: 2 returnable on that line" });
  });

  it("answers 503 and refunds nothing when the entry cannot be written", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const item = await productItem(saleId);
    const res = await withAuditOff(() => refund(t, saleId, item, 1));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await returnedQty(item)).toBe(0);
    const returns = await env.DB.prepare("SELECT COUNT(*) AS n FROM sale_returns WHERE sale_id = ?")
      .bind(saleId)
      .first<{ n: number }>();
    expect(returns?.n).toBe(0);
  });
});

describe("void audit", () => {
  const voidIt = async (t: Till, saleId: string) =>
    dispatch("POST", `/booking/shops/${t.shop}/sales/${saleId}/void`, {
      headers: await authed("admin", t.shop),
      body: {},
    });

  it("records pos.void with the status change", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const res = await voidIt(t, saleId);
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("pos.void", t.shop, saleId);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      shop_id: t.shop,
      entity_type: "sale",
      entity_id: saleId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: ["completed", "voided"] });
    expectNoPersonalData(outcome, [SHOP_NAME]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("records the pending status when a pending Stripe sale is voided", async () => {
    const t = await setup();
    const saleId = await ringOk(t, "stripe", STRIPE_URLS);
    const res = await voidIt(t, saleId);
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("pos.void", t.shop, saleId);
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: ["pending", "voided"] });
  });

  it("voiding an already-voided sale answers 400 and records nothing", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    expect((await voidIt(t, saleId)).status).toBe(200);
    expect((await voidIt(t, saleId)).status).toBe(400);
    expect((await entriesFor({ action: "pos.void", shopId: t.shop })).length).toBe(2);
  });

  /** Run a void with `stage` committed just before the flip batch. The
   *  started entry is batch #1 under run() (Ruling P4); the flip is #2. */
  async function voidWithRaceBeforeFlip(t: Till, saleId: string, stage: string): Promise<Response> {
    let calls = 0;
    let fired = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            calls += 1;
            if (calls === 2 && !fired) {
              fired = true;
              await target.prepare(stage).bind(saleId).run();
            }
            return target.batch(stmts);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof env.DB;
    const res = await dispatchWith({ ...env, DB: db }, "POST", `/booking/shops/${t.shop}/sales/${saleId}/void`, {
      headers: await authed("admin", t.shop),
      body: {},
    });
    expect(fired, "the flip batch never ran, so the race was never staged").toBe(true);
    return res;
  }

  it("records the status the flip found, not the earlier pre-read", async () => {
    const t = await setup();
    // A pending Stripe sale passes the route's pre-checks. Before the flip the
    // sale becomes completed (a settle), so the entry must say completed.
    const saleId = await ringOk(t, "stripe", STRIPE_URLS);
    const res = await voidWithRaceBeforeFlip(t, saleId, "UPDATE sales SET status = 'completed' WHERE id = ?");
    expect(res.status).toBe(200);
    expect(await saleStatus(saleId)).toBe("voided");
    const outcome = await outcomeOf("pos.void", t.shop, saleId);
    expect(outcome.outcome).toBe("succeeded");
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: ["completed", "voided"] });
  });

  it("a void whose flip loses records refused not_voidable, with the response unchanged", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const res = await voidWithRaceBeforeFlip(t, saleId, "UPDATE sales SET status = 'refunded' WHERE id = ?");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await saleStatus(saleId)).toBe("refunded");
    const outcome = await outcomeOf("pos.void", t.shop, saleId);
    expect(outcome).toMatchObject({ outcome: "refused", reason: "not_voidable" });
    expect(outcome.changes_json).toBeNull();
  });

  it("answers 503 and leaves the sale completed when the entry cannot be written", async () => {
    const t = await setup();
    const saleId = await ringOk(t);
    const res = await withAuditOff(() => voidIt(t, saleId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await saleStatus(saleId)).toBe("completed");
    expect(await stockQty(t)).toBe(3);
  });
});
