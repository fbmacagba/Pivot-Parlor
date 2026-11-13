/** Staff View for a developer: the staff screens are one staff member's own
 *  day, and a developer is nobody's staff. They pick a shop (?shopId=) and a
 *  person (?staffId=) and see exactly that person's screens, read-only. Staff
 *  always see their own, whatever the URL says. Lives in lib/ rather than
 *  routes/ so Remix never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the loaders and actions run here. The page modules' UI imports are
// stubbed (as DashboardLayout.test.tsx does): those packages resolve react
// from the root node_modules, where it is not installed.
vi.mock("@remix-run/react", () => {
  const Stub = () => null;
  return {
    Form: Stub,
    Link: Stub,
    Outlet: Stub,
    isRouteErrorResponse: () => false,
    useActionData: () => undefined,
    useFetcher: () => ({ state: "idle", submit: () => undefined }),
    useLoaderData: () => ({}),
    useLocation: () => ({ pathname: "/", search: "" }),
    useNavigate: () => () => undefined,
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
vi.mock("react-qr-code", () => ({ default: () => null }));

import * as layout from "~/routes/staff";
import * as today from "~/routes/staff._index";
import * as bookings from "~/routes/staff.bookings";
import * as availability from "~/routes/staff.availability";
import * as till from "~/routes/staff.pos";

const API_URL = "https://api.test";
const context = { env: { API_URL } };
const SESSION = "pp_session=tok.abc.123";

let calls: Array<{ method: string; path: string }> = [];

/** Stubs the API: /auth/me answers as `role`; shop-1 has Sam, Ali and a former Gone. */
function stubApi(role: "developer" | "staff", shopId: string | null = null) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = `${url.pathname}${url.search}`;
      calls.push({ method: init?.method ?? "GET", path });
      if (url.pathname === "/auth/me") return Response.json({ success: true, data: { id: "u-1", role, shop_id: shopId } });
      if (url.pathname === "/api/shops/shop-1") {
        return Response.json({ success: true, data: { id: "shop-1", slug: "fade-and-blade", name: "Fade and Blade" } });
      }
      if (url.pathname === "/api/shops/shop-1/staff") {
        return Response.json({
          success: true,
          data: [
            { id: "staff-9", display_name: "Sam", is_active: true },
            { id: "staff-2", display_name: "Ali", is_active: true },
            { id: "staff-x", display_name: "Gone", is_active: false },
          ],
        });
      }
      return Response.json({ success: true, data: [] });
    }),
  );
}

function get(path: string): Request {
  return new Request(`https://pivotparlor.com${path}`, { headers: { Cookie: SESSION } });
}

async function load<T>(mod: { loader: (args: never) => unknown }, path: string): Promise<T> {
  const res = (await mod.loader({ request: get(path), context, params: {} } as never)) as Response;
  return (await res.json()) as T;
}

const staffMeCalls = () => calls.filter((c) => c.path.startsWith("/api/staff/me/"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the staff layout, for a developer", () => {
  type Layout = {
    developerView: {
      shopId: string | null;
      shopName: string | null;
      staff: Array<{ id: string; display_name: string }>;
      viewing: { id: string; name: string } | null;
    } | null;
  };

  it("names the shop and the person being viewed, and lists who else can be chosen", async () => {
    stubApi("developer");
    const { developerView } = await load<Layout>(layout, "/staff?shopId=shop-1&staffId=staff-9");
    expect(developerView).toEqual({
      shopId: "shop-1",
      shopName: "Fade and Blade",
      staff: [
        { id: "staff-9", display_name: "Sam" },
        { id: "staff-2", display_name: "Ali" },
      ],
      viewing: { id: "staff-9", name: "Sam" },
    });
  });

  it("views nobody until a current staff member of that shop is chosen", async () => {
    stubApi("developer");
    expect((await load<Layout>(layout, "/staff?shopId=shop-1")).developerView?.viewing).toBeNull();
    expect((await load<Layout>(layout, "/staff?shopId=shop-1&staffId=staff-x")).developerView?.viewing).toBeNull();
    expect((await load<Layout>(layout, "/staff?shopId=shop-1&staffId=other-shop")).developerView?.viewing).toBeNull();
    const noShop = (await load<Layout>(layout, "/staff")).developerView;
    expect(noShop).toMatchObject({ shopId: null, staff: [], viewing: null });
  });

  it("is not shown to staff", async () => {
    stubApi("staff", "shop-own");
    expect((await load<Layout>(layout, "/staff?shopId=shop-1&staffId=staff-9")).developerView).toBeNull();
  });
});

describe("Today, for a developer", () => {
  type Today = { needsStaff: boolean; shopShare: { url: string; name: string } | null };

  it("reads the chosen person's day and shares their shop", async () => {
    stubApi("developer");
    const data = await load<Today>(today, "/staff?shopId=shop-1&staffId=staff-9");
    expect(staffMeCalls().map((c) => c.path)).toEqual(["/api/staff/me/today?staffId=staff-9"]);
    expect(data.needsStaff).toBe(false);
    expect(data.shopShare).toEqual({ url: "https://pivotparlor.com/fade-and-blade", name: "Fade and Blade" });
  });

  it("asks for a person instead of claiming an empty day", async () => {
    stubApi("developer");
    const data = await load<Today>(today, "/staff?shopId=shop-1");
    expect(data.needsStaff).toBe(true);
    expect(staffMeCalls()).toEqual([]);
  });

  it("staff read their own day, ignoring ?staffId=", async () => {
    stubApi("staff", "shop-own");
    const data = await load<Today>(today, "/staff?staffId=staff-9");
    expect(staffMeCalls().map((c) => c.path)).toEqual(["/api/staff/me/today"]);
    expect(data.needsStaff).toBe(false);
  });
});

describe("Bookings and availability, for a developer", () => {
  type Bookings = { readOnly: boolean; needsStaff: boolean };

  it("reads the chosen person's bookings, schedule and time off, read-only", async () => {
    stubApi("developer");
    const data = await load<Bookings>(bookings, "/staff/bookings?shopId=shop-1&staffId=staff-9&filter=past");
    expect(staffMeCalls().map((c) => c.path).sort()).toEqual([
      "/api/staff/me/bookings?filter=past&staffId=staff-9",
      "/api/staff/me/schedule?staffId=staff-9",
      "/api/staff/me/time-off?staffId=staff-9",
    ]);
    expect(data).toMatchObject({ readOnly: true, needsStaff: false });
  });

  it("will not request time off for them", async () => {
    stubApi("developer");
    const request = new Request("https://pivotparlor.com/staff/bookings?shopId=shop-1&staffId=staff-9", {
      method: "POST",
      headers: { Cookie: SESSION, "Content-Type": "application/json" },
      body: JSON.stringify({ from_date: "2026-09-01", to_date: "2026-09-02" }),
    });
    const res = (await bookings.action({ request, context, params: {} } as never)) as Response;
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("staff read and write their own, ignoring ?staffId=", async () => {
    stubApi("staff", "shop-own");
    const data = await load<Bookings>(bookings, "/staff/bookings?staffId=staff-9");
    expect(staffMeCalls().every((c) => !c.path.includes("staffId"))).toBe(true);
    expect(data).toMatchObject({ readOnly: false, needsStaff: false });
  });

  it("the old Availability address keeps the shop and the person", () => {
    const res = availability.loader({ request: get("/staff/availability?shopId=shop-1&staffId=staff-9"), context, params: {} } as never) as Response;
    expect(res.headers.get("Location")).toBe("/staff/bookings?shopId=shop-1&staffId=staff-9&tab=availability");
    const bare = availability.loader({ request: get("/staff/availability"), context, params: {} } as never) as Response;
    expect(bare.headers.get("Location")).toBe("/staff/bookings?tab=availability");
  });
});

/** A loader or action's Response, whether it is returned or thrown (a redirect). */
async function settle(run: () => unknown): Promise<Response> {
  try {
    return (await run()) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

describe("the till, for a developer", () => {
  it("is Admin view's till for that shop, since Staff View is read-only", async () => {
    stubApi("developer");
    const res = await settle(() => till.loader({ request: get("/staff/pos?shopId=shop-1&staffId=staff-9"), context, params: {} } as never));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/pos?shopId=shop-1");
  });

  it("will not take a sale for them", async () => {
    stubApi("developer");
    const body = new FormData();
    body.set("intent", "sale");
    body.set("shopId", "shop-1");
    const request = new Request("https://pivotparlor.com/staff/pos?shopId=shop-1&staffId=staff-9", {
      method: "POST",
      headers: { Cookie: SESSION },
      body,
    });
    const res = await settle(() => till.action({ request, context, params: {} } as never));
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("staff keep their own till", async () => {
    stubApi("staff", "shop-own");
    const res = await settle(() => till.loader({ request: get("/staff/pos?shopId=shop-1"), context, params: {} } as never));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shopId: string | null }).shopId).toBe("shop-own");
  });
});
