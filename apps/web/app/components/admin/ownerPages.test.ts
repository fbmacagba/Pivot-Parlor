/** The owner's Staff, Bookings, Services, Products and Settings pages: what
 *  their loaders ask the API for and what their actions send it. Each case is
 *  a fault the dashboard audit found. Lives beside the admin components rather
 *  than in routes/, so the router never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only loaders and actions run here; the pages' screen imports are stubbed
// (as lib/formActionsRejectNonForm.test.ts does).
vi.mock("react-router", async (importOriginal) => {
  const Stub = () => null;
  return {
    ...(await importOriginal<typeof import("react-router")>()),
    Form: Stub,
    Link: Stub,
    isRouteErrorResponse: () => false,
    useActionData: () => undefined,
    useFetcher: () => ({ state: "idle", submit: () => undefined, load: () => undefined }),
    useLoaderData: () => ({}),
    useLocation: () => ({ pathname: "/", search: "" }),
    useNavigation: () => ({ state: "idle" }),
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useRouteError: () => null,
    useSearchParams: () => [new URLSearchParams(), () => undefined],
  };
});
vi.mock(
  "lucide-react",
  () =>
    new Proxy(
      {},
      {
        get: (_t, key) => (key === "then" ? undefined : () => null),
        has: (_t, key) => key !== "then",
      },
    ),
);
vi.mock(
  "@radix-ui/react-dialog",
  () =>
    new Proxy(
      {},
      {
        get: (_t, key) => (key === "then" ? undefined : () => null),
        has: (_t, key) => key !== "then",
      },
    ),
);
vi.mock(
  "@radix-ui/react-slot",
  () =>
    new Proxy(
      {},
      {
        get: (_t, key) => (key === "then" ? undefined : () => null),
        has: (_t, key) => key !== "then",
      },
    ),
);

import * as staffPage from "~/routes/admin.staff";
import * as bookingsPage from "~/routes/admin.bookings";
import * as servicesPage from "~/routes/admin.services";
import * as productsPage from "~/routes/admin.products";
import * as settingsPage from "~/routes/admin.settings";
import { asResponse } from "~/lib/testing/asResponse";

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];

/** Answers /auth/me as an admin of shop-1, and every API call from `answers`
 *  (keyed by path without the query string). An answer of "fail" is a 500. */
function stubApi(answers: Record<string, unknown> = {}): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/me") {
        return Response.json({ success: true, data: { id: "u-1", role: "admin", shop_id: "shop-1" } });
      }
      calls.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const answer = answers[url.pathname];
      if (answer === "fail") return Response.json({ success: false, error: "Database is down" }, { status: 500 });
      return Response.json({ success: true, data: answer ?? [] });
    }),
  );
}

const COOKIE = { Cookie: "pp_session=tok.abc.123" };
type Handler = (args: never) => unknown;

async function load<T>(page: { loader: Handler }, path: string): Promise<T> {
  const res = asResponse(
    await page.loader({
      request: new Request(`https://pivotparlor.com${path}`, { headers: COOKIE }),
      params: {},
      context: { env: { API_URL: "https://api.test" } },
    } as never),
  );
  return (await res.json()) as T;
}

async function post(page: { action: Handler }, path: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = asResponse(
    await page.action({
      request: new Request(`https://pivotparlor.com${path}`, {
        method: "POST",
        headers: COOKIE,
        body: new URLSearchParams(fields),
      }),
      params: {},
      context: { env: { API_URL: "https://api.test" } },
    } as never),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("staff page", () => {
  // The services list answers in the public shape. Read in the raw shape it
  // held no active service, so the assignment block was never drawn.
  const SERVICES = [
    { id: "s1", shopId: "shop-1", name: "Skin fade", durationMinutes: 30, price_pence: 2500, isActive: true },
    { id: "s2", shopId: "shop-1", name: "Old cut", durationMinutes: 45, price_pence: 3000, isActive: false },
  ];

  it("offers the shop's active services for assignment, and loads deactivated staff too", async () => {
    stubApi({
      "/api/shops/shop-1/services": SERVICES,
      "/api/shops/shop-1/staff": [{ id: "m1", display_name: "Sam", is_active: 1 }, { id: "m2", display_name: "Lee", is_active: 0 }],
    });
    const data = await load<{ services: unknown[]; staff: unknown[]; loadError: boolean; servicesLoadError: boolean }>(staffPage, "/admin/staff");
    expect(data.services).toEqual([{ id: "s1", name: "Skin fade", durationMinutes: 30, price_pence: 2500 }]);
    expect(data.staff).toHaveLength(2);
    expect(data.loadError).toBe(false);
    expect(data.servicesLoadError).toBe(false);
    expect(calls.map((c) => c.path)).toContain("/api/shops/shop-1/staff?include_inactive=1");
  });

  it("says so when the staff list cannot be loaded, instead of reading as no staff", async () => {
    stubApi({ "/api/shops/shop-1/staff": "fail" });
    const data = await load<{ loadError: boolean; staff: unknown[] }>(staffPage, "/admin/staff");
    expect(data.loadError).toBe(true);
  });

  it("saves the ticked services", async () => {
    stubApi();
    const res = await post(staffPage, "/admin/staff", { intent: "edit", staffId: "m1", display_name: "Sam", service_ids: "s1,s3" });
    expect(res.body).toMatchObject({ ok: true, intent: "edit" });
    expect(calls).toEqual([
      { method: "PUT", path: "/api/shops/shop-1/staff/m1", body: { display_name: "Sam", bio: null, speciality: null, service_ids: ["s1", "s3"] } },
    ]);
  });

  it("clears every service when all are unticked, and leaves them alone when the list was not sent", async () => {
    stubApi();
    await post(staffPage, "/admin/staff", { intent: "edit", staffId: "m1", display_name: "Sam", service_ids: "" });
    expect((calls[0].body as { service_ids?: unknown }).service_ids).toEqual([]);

    stubApi();
    await post(staffPage, "/admin/staff", { intent: "edit", staffId: "m1", display_name: "Sam" });
    expect(calls[0].body).not.toHaveProperty("service_ids");
  });

  it("restores a deactivated member", async () => {
    stubApi();
    const res = await post(staffPage, "/admin/staff", { intent: "restore", staffId: "m2" });
    expect(res.body).toMatchObject({ ok: true, intent: "restore" });
    expect(calls).toEqual([{ method: "PUT", path: "/api/shops/shop-1/staff/m2", body: { is_active: 1 } }]);
  });

  it("answers a refused invite with the reason and the intent it belongs to", async () => {
    stubApi({ "/api/shops/shop-1/staff": "fail" });
    const res = await post(staffPage, "/admin/staff", { intent: "invite", name: "Sam", email: "sam@example.com" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, intent: "invite", error: "Database is down" });
  });
});

describe("bookings page", () => {
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };

  it("with no dates chosen, asks for 30 days back to 90 days ahead, up to the limit", async () => {
    at("2026-11-27T12:00:00Z");
    stubApi();
    const data = await load<{ window: unknown; truncated: boolean; loadError: boolean }>(bookingsPage, "/admin/bookings");
    expect(calls.map((c) => c.path)).toEqual([
      "/api/shops/shop-1/bookings?date_from=2026-10-28&date_to=2027-02-25&limit=1000",
      // Which deposits already have a refund request waiting.
      "/api/shops/shop-1/refund-requests?status=pending",
    ]);
    expect(data.window).toEqual({ from: "2026-10-28", to: "2027-02-25", isDefault: true });
    expect(data.truncated).toBe(false);
    expect(data.loadError).toBe(false);
  });

  it("sends the person's own From, To and status", async () => {
    at("2026-11-27T12:00:00Z");
    stubApi();
    await load(bookingsPage, "/admin/bookings?from=2026-01-01&to=2026-01-31&status=confirmed");
    expect(calls.map((c) => c.path).filter((path) => path.includes("/bookings"))).toEqual([
      "/api/shops/shop-1/bookings?status=confirmed&date_from=2026-01-01&date_to=2026-01-31&limit=1000",
    ]);
  });

  it("flags a list that came back at the limit as cut short", async () => {
    at("2026-11-27T12:00:00Z");
    const row = { id: "b", booking_date: "2026-11-27", status: "confirmed", amount_pence: 100 };
    stubApi({ "/api/shops/shop-1/bookings": Array.from({ length: 1000 }, (_, i) => ({ ...row, id: `b${i}` })) });
    const data = await load<{ truncated: boolean; stats: { total: number } }>(bookingsPage, "/admin/bookings");
    expect(data.truncated).toBe(true);
    expect(data.stats.total).toBe(1000);
  });

  it("reports a failed load as a failure, not as no bookings", async () => {
    stubApi({ "/api/shops/shop-1/bookings": "fail" });
    const data = await load<{ loadError: boolean; bookings: unknown[] }>(bookingsPage, "/admin/bookings");
    expect(data.loadError).toBe(true);
    expect(data.bookings).toEqual([]);
  });
});

describe("services page", () => {
  it("loads deactivated services too, so one can be restored", async () => {
    stubApi();
    await load(servicesPage, "/admin/services");
    expect(calls.map((c) => c.path)).toEqual(["/api/shops/shop-1/services?include_inactive=1"]);
  });

  it.each(["create", "update"])("refuses a %s with no readable duration, and sends nothing", async (intent) => {
    for (const duration of ["", "abc", "0", "-30", "12.5"]) {
      stubApi();
      const res = await post(servicesPage, "/admin/services", { intent, serviceId: "s1", name: "Cut", price: "25", duration_min: duration });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, intent });
      expect(calls).toEqual([]);
    }
  });

  it("saves an update with a whole number of minutes", async () => {
    stubApi();
    const res = await post(servicesPage, "/admin/services", { intent: "update", serviceId: "s1", name: "Cut", price: "25.50", duration_min: "45" });
    expect(res.body).toMatchObject({ ok: true, intent: "update" });
    expect(calls).toEqual([
      { method: "PUT", path: "/api/shops/shop-1/services/s1", body: { name: "Cut", category: null, price_pence: 2550, duration_min: 45 } },
    ]);
  });
});

describe("products page", () => {
  it("loads deactivated products too, and reports a failed list as a failure", async () => {
    stubApi({ "/api/shops/shop-1/products": "fail" });
    const data = await load<{ loadError: boolean }>(productsPage, "/admin/products");
    expect(calls.map((c) => c.path)).toContain("/api/shops/shop-1/products?include_inactive=1");
    expect(data.loadError).toBe(true);
  });

  it("removes stock for waste even though the quantity is typed as a plain number", async () => {
    stubApi();
    const res = await post(productsPage, "/admin/products", { intent: "movement", productId: "p1", type: "waste", quantity: "3" });
    expect(res.body).toMatchObject({ ok: true, intent: "movement" });
    expect(calls).toEqual([
      { method: "POST", path: "/api/shops/shop-1/inventory/movements", body: { product_id: "p1", type: "waste", quantity_delta: -3, note: null } },
    ]);
  });

  it("adds stock for a delivery, and refuses a correction that does not say which way", async () => {
    stubApi();
    await post(productsPage, "/admin/products", { intent: "movement", productId: "p1", type: "receive", quantity: "12" });
    expect((calls[0].body as { quantity_delta: number }).quantity_delta).toBe(12);

    stubApi();
    const res = await post(productsPage, "/admin/products", { intent: "movement", productId: "p1", type: "adjustment", quantity: "2" });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("opens the low stock alert on the product's saved levels", async () => {
    stubApi({
      "/api/shops/shop-1/products/p1": {
        id: "p1",
        stock: [
          { variant_id: "v1", reorder_point: 9, reorder_qty: 9 },
          { variant_id: null, reorder_point: 4, reorder_qty: 24 },
        ],
      },
    });
    const data = await load<{ alertLevels: unknown; alertLevelsError: boolean }>(productsPage, "/admin/products?alertLevelsFor=p1");
    expect(data.alertLevels).toEqual({ productId: "p1", reorder_point: 4, reorder_qty: 24 });
    expect(calls.map((c) => c.path)).toEqual(["/api/shops/shop-1/products/p1"]);
  });

  it("does not invent alert levels when they cannot be loaded", async () => {
    stubApi({ "/api/shops/shop-1/products/p1": "fail" });
    const data = await load<{ alertLevels: unknown; alertLevelsError: boolean }>(productsPage, "/admin/products?alertLevelsFor=p1");
    expect(data.alertLevels).toBeNull();
    expect(data.alertLevelsError).toBe(true);
  });
});

describe("settings page", () => {
  it("reports a failed load, so the page shows no form to save over the real settings", async () => {
    stubApi({ "/api/shops/shop-1/settings": "fail" });
    const data = await load<{ loadError: boolean }>(settingsPage, "/admin/settings");
    expect(data.loadError).toBe(true);
  });

  it("passes loaded settings through (control)", async () => {
    stubApi({ "/api/shops/shop-1/settings": { phone: "020 7946 0000" } });
    const data = await load<{ loadError: boolean; settings: { phone?: string } }>(settingsPage, "/admin/settings");
    expect(data.loadError).toBe(false);
    expect(data.settings.phone).toBe("020 7946 0000");
  });
});
