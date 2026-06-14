import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedUser, seedWaitlistEntry, tokenFor } from "./helpers";
import { dispatch } from "./request";

let shopA: string, shopB: string;
let entryB: string;
let adminAToken: string, adminBToken: string, customerToken: string, devToken: string;

beforeAll(async () => {
  shopA = await seedShop("Shop A");
  shopB = await seedShop("Shop B");
  entryB = await seedWaitlistEntry(shopB);
  adminAToken = await tokenFor(await seedUser("admin", shopA), "admin", shopA);
  adminBToken = await tokenFor(await seedUser("admin", shopB), "admin", shopB);
  customerToken = await tokenFor(await seedUser("customer", null), "customer", null);
  devToken = await tokenFor(await seedUser("developer", null), "developer", null);
});

async function statusOf(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM waitlist WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

describe("waitlist status update scoping (IDOR)", () => {
  it("admin of shop A cannot update a shop B waitlist entry", async () => {
    const res = await dispatch("PATCH", `/api/waitlist/${entryB}/status`, {
      headers: authHeaders(adminAToken),
      body: { status: "expired" },
    });
    expect(res.status).toBe(404);
    expect(await statusOf(entryB)).toBe("waiting");
  });

  it("a customer cannot update any waitlist entry", async () => {
    const res = await dispatch("PATCH", `/api/waitlist/${entryB}/status`, {
      headers: authHeaders(customerToken),
      body: { status: "expired" },
    });
    expect(res.status).toBe(403);
    expect(await statusOf(entryB)).toBe("waiting");
  });

  it("admin of shop B can update their own entry", async () => {
    const res = await dispatch("PATCH", `/api/waitlist/${entryB}/status`, {
      headers: authHeaders(adminBToken),
      body: { status: "notified" },
    });
    expect(res.status).toBe(200);
    expect(await statusOf(entryB)).toBe("notified");
  });

  it("developer can update any entry", async () => {
    const res = await dispatch("PATCH", `/api/waitlist/${entryB}/status`, {
      headers: authHeaders(devToken),
      body: { status: "booked" },
    });
    expect(res.status).toBe(200);
    expect(await statusOf(entryB)).toBe("booked");
  });

  it("unknown entry id returns 404", async () => {
    const res = await dispatch("PATCH", `/api/waitlist/does-not-exist/status`, {
      headers: authHeaders(devToken),
      body: { status: "booked" },
    });
    expect(res.status).toBe(404);
  });
});
