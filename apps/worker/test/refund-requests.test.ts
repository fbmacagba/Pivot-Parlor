/**
 * Refund review, API half: /api/shops/:shopId/refund-requests.
 *
 * The booking worker owns the requests and the rule that a refund needs one
 * (tested in its own suite). This worker stores the optional evidence file in
 * the private audit bucket and hands its key on; the BOOKING binding here is
 * the echo stub, so these tests read exactly what was forwarded.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";

type Echo = { success: boolean; data: { stub: string; url: string; method: string; body: string | null } };

async function adminToken(shopId: string): Promise<string> {
  return tokenFor(await seedUser("admin", shopId), "admin", shopId);
}

async function staffToken(shopId: string): Promise<string> {
  const staffId = await seedStaff(shopId);
  const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?").bind(staffId).first<{ user_id: string }>();
  return tokenFor(row!.user_id, "staff", shopId);
}

async function postForm(path: string, token: string, form: FormData): Promise<Response> {
  const request = new Request(`https://worker.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as never, env as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

async function evidenceKeys(shopId: string): Promise<string[]> {
  const listed = await env.AUDIT_ARCHIVE.list({ prefix: `refund-evidence/${shopId}/` });
  return listed.objects.map((o) => o.key);
}

function requestForm(file?: File): FormData {
  const form = new FormData();
  form.set("kind", "sale");
  form.set("sale_id", "sale-1");
  form.set("lines", JSON.stringify([{ sale_item_id: "item-1", quantity: 1 }]));
  form.set("reason", "Customer returned it sealed, receipt attached");
  if (file) form.set("evidence", file);
  return form;
}

describe("filing a refund request", () => {
  it("stores the evidence file privately and forwards its key with the request", async () => {
    const shopId = await seedShop("evidence");
    const token = await staffToken(shopId);
    const file = new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], "receipt.png", { type: "image/png" });

    const res = await postForm(`/api/shops/${shopId}/refund-requests`, token, requestForm(file));
    expect(res.status).toBe(201);
    const echo = (await res.json()) as Echo;
    expect(echo.data.url).toBe(`https://booking/booking/shops/${shopId}/refund-requests`);
    const forwarded = JSON.parse(echo.data.body ?? "{}") as Record<string, unknown>;
    expect(forwarded).toMatchObject({
      kind: "sale",
      sale_id: "sale-1",
      lines: [{ sale_item_id: "item-1", quantity: 1 }],
      reason: "Customer returned it sealed, receipt attached",
      evidence_name: "receipt.png",
      evidence_type: "image/png",
    });
    const keys = await evidenceKeys(shopId);
    expect(keys).toHaveLength(1);
    expect(forwarded.evidence_key).toBe(keys[0]);
    expect(keys[0]).toMatch(new RegExp(`^refund-evidence/${shopId}/[0-9a-f-]{36}\\.png$`));
    // Never in the public assets bucket.
    expect((await env.ASSETS.list({ prefix: "refund-evidence/" })).objects).toHaveLength(0);
  });

  it("files without a file, and never trusts an evidence key sent by the caller", async () => {
    const shopId = await seedShop("no-evidence");
    const token = await adminToken(shopId);
    const res = await dispatch("POST", `/api/shops/${shopId}/refund-requests`, {
      headers: authHeaders(token),
      body: {
        kind: "deposit",
        booking_id: "b-1",
        reason: "Cancelled a week ahead by phone",
        evidence_key: "anchors/2026-01-01.json",
        evidence_name: "x",
        evidence_type: "image/png",
      },
    });
    expect(res.status).toBe(201);
    const forwarded = JSON.parse(((await res.json()) as Echo).data.body ?? "{}") as Record<string, unknown>;
    expect(forwarded).toEqual({ kind: "deposit", booking_id: "b-1", reason: "Cancelled a week ahead by phone" });
    expect(await evidenceKeys(shopId)).toHaveLength(0);
  });

  it("forwards a shop cancellation from the form, and nothing else the form adds", async () => {
    const shopId = await seedShop("shop-cancel");
    const token = await adminToken(shopId);
    const form = new FormData();
    form.set("kind", "deposit");
    form.set("booking_id", "b-1");
    form.set("shop_cancelled", "1");
    form.set("status", "approved");
    const res = await postForm(`/api/shops/${shopId}/refund-requests`, token, form);
    expect(res.status).toBe(201);
    const forwarded = JSON.parse(((await res.json()) as Echo).data.body ?? "{}") as Record<string, unknown>;
    expect(forwarded).toEqual({ kind: "deposit", booking_id: "b-1", shop_cancelled: true });
  });

  it("refuses a file that is not an image or a PDF, and one over 5MB, storing nothing", async () => {
    const shopId = await seedShop("bad-evidence");
    const token = await adminToken(shopId);

    const html = new File(["<script>alert(1)</script>"], "note.html", { type: "text/html" });
    const wrongType = await postForm(`/api/shops/${shopId}/refund-requests`, token, requestForm(html));
    expect(wrongType.status).toBe(400);

    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
    const tooBig = await postForm(`/api/shops/${shopId}/refund-requests`, token, requestForm(big));
    expect(tooBig.status).toBe(400);

    expect(await evidenceKeys(shopId)).toHaveLength(0);
  });

  it("is closed to customers, to other shops' staff and to signed-out callers", async () => {
    const shopId = await seedShop("closed");
    const other = await seedShop("other");
    const body = { kind: "deposit", booking_id: "b-1", reason: "Cancelled a week ahead by phone" };

    const signedOut = await dispatch("POST", `/api/shops/${shopId}/refund-requests`, { body });
    expect(signedOut.status).toBe(401);
    const otherStaff = await dispatch("POST", `/api/shops/${shopId}/refund-requests`, {
      headers: authHeaders(await staffToken(other)),
      body,
    });
    expect(otherStaff.status).toBe(403);
    const customer = await dispatch("POST", `/api/shops/${shopId}/refund-requests`, {
      headers: authHeaders(await tokenFor(await seedUser("customer", null), "customer", null)),
      body,
    });
    expect(customer.status).toBe(403);
  });
});

describe("adding evidence to a waiting request", () => {
  it("stores the file privately and forwards its key to the booking worker", async () => {
    const shopId = await seedShop("add-evidence");
    const token = await staffToken(shopId);
    const form = new FormData();
    form.set("evidence", new File([new Uint8Array([1, 2, 3])], "text.jpg", { type: "image/jpeg" }));
    const res = await postForm(`/api/shops/${shopId}/refund-requests/rr-1/evidence`, token, form);
    expect(res.status).toBe(201);
    const echo = (await res.json()) as Echo;
    expect(echo.data.url).toBe(`https://booking/booking/shops/${shopId}/refund-requests/rr-1/evidence`);
    const forwarded = JSON.parse(echo.data.body ?? "{}") as Record<string, unknown>;
    const keys = await evidenceKeys(shopId);
    expect(keys).toHaveLength(1);
    expect(forwarded).toEqual({ evidence_key: keys[0], evidence_name: "text.jpg", evidence_type: "image/jpeg" });
  });

  it("needs a file of an allowed kind, and stores nothing otherwise", async () => {
    const shopId = await seedShop("add-evidence-bad");
    const token = await adminToken(shopId);
    const none = await postForm(`/api/shops/${shopId}/refund-requests/rr-1/evidence`, token, new FormData());
    expect(none.status).toBe(400);
    const form = new FormData();
    form.set("evidence", new File(["<p>x</p>"], "note.html", { type: "text/html" }));
    const bad = await postForm(`/api/shops/${shopId}/refund-requests/rr-1/evidence`, token, form);
    expect(bad.status).toBe(400);
    expect(await evidenceKeys(shopId)).toHaveLength(0);
  });

  it("is closed to another shop's staff", async () => {
    const shopId = await seedShop("add-evidence-own");
    const other = await seedShop("add-evidence-other");
    const form = new FormData();
    form.set("evidence", new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    const res = await postForm(`/api/shops/${shopId}/refund-requests/rr-1/evidence`, await staffToken(other), form);
    expect(res.status).toBe(403);
    expect(await evidenceKeys(shopId)).toHaveLength(0);
  });
});

describe("reviewing refund requests", () => {
  it("forwards the list, and lets only the owner decline", async () => {
    const shopId = await seedShop("review");
    const admin = await adminToken(shopId);
    const staff = await staffToken(shopId);

    const list = await dispatch("GET", `/api/shops/${shopId}/refund-requests?status=pending`, { headers: authHeaders(staff) });
    expect(list.status).toBe(200);
    expect(((await list.json()) as Echo).data.url).toBe(
      `https://booking/booking/shops/${shopId}/refund-requests?status=pending`
    );

    const byStaff = await dispatch("POST", `/api/shops/${shopId}/refund-requests/rr-1/decline`, {
      headers: authHeaders(staff),
      body: { note: "no" },
    });
    expect(byStaff.status).toBe(403);

    const byOwner = await dispatch("POST", `/api/shops/${shopId}/refund-requests/rr-1/decline`, {
      headers: authHeaders(admin),
      body: { note: "Outside the returns window" },
    });
    expect(byOwner.status).toBe(201);
    const echo = (await byOwner.json()) as Echo;
    expect(echo.data.url).toBe(`https://booking/booking/shops/${shopId}/refund-requests/rr-1/decline`);
    expect(JSON.parse(echo.data.body ?? "{}")).toEqual({ note: "Outside the returns window" });
  });

  it("shows an evidence file only to the shop it belongs to", async () => {
    const shopId = await seedShop("show");
    const other = await seedShop("show-other");
    const key = `refund-evidence/${shopId}/${crypto.randomUUID()}.pdf`;
    await env.AUDIT_ARCHIVE.put(key, new Uint8Array([37, 80, 68, 70]), { httpMetadata: { contentType: "application/pdf" } });
    await env.DB.prepare(
      `INSERT INTO refund_requests (id, shop_id, kind, sale_id, lines_json, amount_pence, reason,
         evidence_key, evidence_name, evidence_type, status, requested_by, requested_at)
       VALUES ('rr-show', ?, 'sale', 'sale-1', '[]', 1000, 'Receipt shows the wrong item was rung up',
         ?, 'receipt "final".pdf', 'application/pdf', 'pending', 'user-1', '2026-11-27T10:00:00.000Z')`
    )
      .bind(shopId, key)
      .run();

    const mine = await dispatch("GET", `/api/shops/${shopId}/refund-requests/rr-show/evidence`, {
      headers: authHeaders(await staffToken(shopId)),
    });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("Content-Type")).toBe("application/pdf");
    expect(mine.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mine.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(mine.headers.get("Content-Disposition")).toBe('inline; filename="receipt _final_.pdf"');
    expect(new Uint8Array(await mine.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));

    // Another shop's owner asking under their own shop finds nothing; asking
    // under this shop is refused outright.
    const otherAdmin = await adminToken(other);
    const wrongShop = await dispatch("GET", `/api/shops/${other}/refund-requests/rr-show/evidence`, {
      headers: authHeaders(otherAdmin),
    });
    expect(wrongShop.status).toBe(404);
    const crossShop = await dispatch("GET", `/api/shops/${shopId}/refund-requests/rr-show/evidence`, {
      headers: authHeaders(otherAdmin),
    });
    expect(crossShop.status).toBe(403);
    const signedOut = await dispatch("GET", `/api/shops/${shopId}/refund-requests/rr-show/evidence`);
    expect(signedOut.status).toBe(401);
  });
});
