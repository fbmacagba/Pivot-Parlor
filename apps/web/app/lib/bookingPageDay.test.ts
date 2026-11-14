/**
 * The public booking page's "today" is the shop's day, not UTC's.
 *
 * From midnight to 1am in British Summer Time, UTC is still on yesterday. The
 * page took today from UTC for two things: the earliest date the date picker
 * offers, and whether a day kept in the page's address may be restored. So in
 * that hour a visitor could pick, or come back to, yesterday.
 *
 * Lives in lib/ rather than routes/ so Remix never mounts it as a route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@remix-run/react", () => ({ Outlet: () => null, useLoaderData: () => null }));
vi.mock("~/components/ErrorScreen", () => ({ ErrorScreen: () => null }));
vi.mock("~/components/CommercialShopChrome", () => ({ CommercialShopChrome: () => null }));
vi.mock("~/components/ThemedBookingControls", () => ({
  ThemedButton: () => null,
  ThemedInput: () => null,
  ThemedTextarea: () => null,
  lightDark: {},
  platformFallbackVars: {},
}));
import { loader } from "~/routes/$shopSlug.book";

const API = "https://api.test";
const SLUG = "linden-barbers";
const SHOP_ID = "shop-linden";

/** A fake API for one fictional shop in `timezone`. */
function shopApi(timezone: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).slice(API.length);
    const ok = (data: unknown) => Response.json({ success: true, data });
    if (path === `/api/shops/${SLUG}`) return ok({ id: SHOP_ID, timezone });
    if (path === `/api/shops/${SHOP_ID}/services`)
      return ok([{ id: "svc-cut", shopId: SHOP_ID, name: "Cut", durationMinutes: 30, price_pence: 2000, isActive: true }]);
    if (path === `/api/shops/${SHOP_ID}/booking-staff`) return ok([{ id: "st-ana", display_name: "Ana Reyes" }]);
    if (path === `/api/shops/${SHOP_ID}/settings`) return ok({});
    return Response.json({ success: false, error: "unexpected" }, { status: 500 });
  });
}

/** The page loaded with a service, a team member and `day` kept in its address. */
async function load(day: string, timezone = "Europe/London") {
  shopApi(timezone);
  const res = await loader({
    params: { shopSlug: SLUG },
    context: { env: { API_URL: API } },
    request: new Request(`https://pivotparlor.test/${SLUG}/book?serviceId=svc-cut&staffId=st-ana&day=${day}&step=2`),
  } as never);
  return (await res.json()) as { today?: string; preselectDay: string };
}

beforeEach(() => {
  // 00:30 on 2 July in London (summer time), still 1 July in UTC.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T23:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the booking page at 00:30 London time on 2 July", () => {
  it("gives the date picker the shop's today, 2 July, as the earliest day", async () => {
    expect((await load("2026-07-02")).today).toBe("2026-07-02");
  });

  it("does not restore yesterday, 1 July, from the page's address", async () => {
    expect((await load("2026-07-01")).preselectDay).toBe("");
  });

  it("control: restores today", async () => {
    expect((await load("2026-07-02")).preselectDay).toBe("2026-07-02");
  });

  it("a shop in another zone reads its own day (still 1 July in New York)", async () => {
    const page = await load("2026-07-01", "America/New_York");
    expect(page.today).toBe("2026-07-01");
    expect(page.preselectDay).toBe("2026-07-01");
  });
});
