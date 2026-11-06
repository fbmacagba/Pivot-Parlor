import { afterEach, describe, expect, it, vi } from "vitest";
import { getPortfolioDemoData } from "./portfolioDemo";
import { isPortfolioDemoShop, PORTFOLIO_DEMO_SLUG } from "@repo/utils";
vi.mock("@remix-run/react", () => ({ Outlet: () => null }));
vi.mock("~/components/ErrorScreen", () => ({ ErrorScreen: () => null }));
vi.mock("~/components/CommercialShopChrome", () => ({
  CommercialShopChrome: () => null,
}));
vi.mock("~/components/ThemedBookingControls", () => ({
  ThemedButton: () => null,
  ThemedInput: () => null,
  ThemedTextarea: () => null,
  lightDark: {},
  platformFallbackVars: {},
}));
import { loader } from "~/routes/$shopSlug";
import {
  action as bookAction,
  loader as bookLoader,
} from "~/routes/$shopSlug.book";
import { action as waitlistAction } from "~/routes/$shopSlug.waitlist";

const API = "https://api.test";
const BACKING = "pp-demo-ferdyms-barber";
const ctx = { env: { API_URL: API } };

/** A fake API for a provisioned demo shop; records every request. */
function backingApi(opts: { provisioned: boolean }) {
  const calls: Array<{ method: string; url: string }> = [];
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (!opts.provisioned) return new Response(JSON.stringify({ success: false, error: "Shop not found" }), { status: 404 });
    const path = url.slice(API.length);
    if (path === `/api/shops/${BACKING}`) return ok({ id: BACKING, name: "FerdyM's Barber Shop", slug: "ferdyms-barber-shop-demo", timezone: "Europe/London" });
    if (path === `/api/shops/${BACKING}/site`) return ok({ template: "classic", headline: "Precise fades", tagline: "", about: "", services: [], website_status: "live", catalog_images: [], hero_image_url: null, logo_url: null });
    if (path === `/api/shops/${BACKING}/services`)
      return ok([{ id: "svc-fade", shopId: BACKING, name: "Skin fade", description: "Faded to the skin.", durationMinutes: 40, price_pence: 2400, category: "Cuts", isActive: true }]);
    if (path === `/api/shops/${BACKING}/booking-staff`) return ok([{ id: "st-kofi", display_name: "Kofi Asante", speciality: "Skin fades" }]);
    if (path === `/api/shops/${BACKING}/settings`) return ok({ hours_json: JSON.stringify({ tue: "09:00-18:00", sat: "09:00-17:00" }) });
    return new Response(JSON.stringify({ success: false, error: "unexpected" }), { status: 500 });
  });
  return { calls, spy };
}

function expectReadOnly(calls: Array<{ method: string; url: string }>) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.method).toBe("GET");
    // Only the fictional backing shop, never the real tenant behind the alias.
    expect(c.url.startsWith(`${API}/api/shops/${BACKING}`)).toBe(true);
    expect(c.url).not.toMatch(/\/slots|\/bookings|\/abandon|\/reviews|\/waitlist|\/walkin/);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("portfolio demonstration", () => {
  it("refuses booking and waitlist form actions before parsing details or calling APIs", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No live API allowed"));
    for (const action of [bookAction, waitlistAction]) {
      const response = await action({
        params: { shopSlug: PORTFOLIO_DEMO_SLUG },
        context: ctx,
        request: new Request(`https://demo.test/${PORTFOLIO_DEMO_SLUG}/book`, { method: "POST" }),
      } as never);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: expect.stringContaining("demonstration"),
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders the generated backing shop by id, read-only, without reviews", async () => {
    const { calls } = backingApi({ provisioned: true });
    const response = await loader({
      params: { shopSlug: PORTFOLIO_DEMO_SLUG },
      context: ctx,
      request: new Request(`https://demo.test/${PORTFOLIO_DEMO_SLUG}`),
    } as never);
    const data = await response.json();
    expect(data.slug).toBe(PORTFOLIO_DEMO_SLUG);
    expect(data.shop.id).toBe(BACKING);
    expect(data.commercialServices.map((s: { name: string }) => s.name)).toEqual(["Skin fade"]);
    expect(data.reviews).toEqual([]);
    expectReadOnly(calls);
  });

  it("keeps the published URL working with the static sample until the backing shop exists", async () => {
    const { calls } = backingApi({ provisioned: false });
    const response = await loader({
      params: { shopSlug: PORTFOLIO_DEMO_SLUG },
      context: ctx,
      request: new Request(`https://demo.test/${PORTFOLIO_DEMO_SLUG}`),
    } as never);
    expect(response.status).toBe(200);
    expect((await response.json()).shop.id).toBe(BACKING);
    expectReadOnly(calls);
  });

  it("404s a new demo URL whose backing shop is not provisioned (no sample stand-in)", async () => {
    backingApi({ provisioned: false });
    await expect(
      loader({
        params: { shopSlug: "linden-and-lark-demo" },
        context: ctx,
        request: new Request("https://demo.test/linden-and-lark-demo"),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("demo booking shows the backing shop's real menu with synthetic times inside its hours", async () => {
    const { calls } = backingApi({ provisioned: true });
    const res = await bookLoader({
      params: { shopSlug: PORTFOLIO_DEMO_SLUG },
      context: ctx,
      // 2099-06-16 is a Tuesday (open 09:00-18:00).
      request: new Request(`https://demo.test/${PORTFOLIO_DEMO_SLUG}/book?date=2099-06-16&service_id=svc-fade&serviceId=svc-fade&staffId=st-kofi`),
    } as never);
    const data = await res.json();
    expect(data.services.map((s: { id: string }) => s.id)).toEqual(["svc-fade"]);
    expect(data.deposit).toBeNull();
    expect(data.preselectServiceId).toBe("svc-fade");
    expect(data.preselectStaffId).toBe("st-kofi");
    expect(data.slots.length).toBeGreaterThan(0);
    expect(data.slots.every((s: { staff_id: string }) => s.staff_id === "st-kofi")).toBe(true);
    expectReadOnly(calls);
  });

  it("demo booking reports a closed day instead of offering times", async () => {
    backingApi({ provisioned: true });
    const res = await bookLoader({
      params: { shopSlug: PORTFOLIO_DEMO_SLUG },
      context: ctx,
      // 2099-06-15 is a Monday (closed).
      request: new Request(`https://demo.test/${PORTFOLIO_DEMO_SLUG}/book?date=2099-06-15&service_id=svc-fade`),
    } as never);
    const data = await res.json();
    expect(data.slots).toEqual([]);
    expect(data.closedDay).toBe(true);
  });

  it("ignores preselect ids that are not on this shop's own lists", async () => {
    backingApi({ provisioned: true });
    const res = await bookLoader({
      params: { shopSlug: PORTFOLIO_DEMO_SLUG },
      context: ctx,
      request: new Request(`https://demo.test/${PORTFOLIO_DEMO_SLUG}/book?serviceId=someone-elses&staffId=x`),
    } as never);
    const data = await res.json();
    expect(data.preselectServiceId).toBe("");
    expect(data.preselectStaffId).toBe("");
  });

  it("recognizes only the server-owned demonstration slugs", () => {
    expect(isPortfolioDemoShop(PORTFOLIO_DEMO_SLUG)).toBe(true);
    expect(isPortfolioDemoShop("linden-and-lark-demo")).toBe(true);
    for (const candidate of ["", "another-shop", `${PORTFOLIO_DEMO_SLUG}-copy`, BACKING, undefined]) {
      expect(isPortfolioDemoShop(candidate)).toBe(false);
    }
  });

  it("the static stand-in carries no reviews, ratings or personal contact details", () => {
    const data = getPortfolioDemoData();
    expect(data.reviews).toEqual([]);
    expect(data.settings.phone).toBeUndefined();
    expect(data.settings.address).toBeUndefined();
    expect(data.staff.every((s) => !/staff\s*\d|test/i.test(s.display_name))).toBe(true);
  });
});
