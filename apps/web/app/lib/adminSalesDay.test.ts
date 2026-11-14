/** The admin sales page opens on the shop's day. A UK shop's day starts at
 *  midnight London time, which in British Summer Time is 23:00 UTC the
 *  evening before; the booking worker's sales list reads the shop's day too
 *  (apps/workers/booking/src/lib/time.ts). Lives in lib/ rather than routes/
 *  so Remix never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the loader runs here; the page's UI imports are stubbed (as
// formActionsRejectNonForm.test.ts does).
vi.mock("@remix-run/react", () => {
  const Stub = () => null;
  return {
    Form: Stub,
    Link: Stub,
    useActionData: () => undefined,
    useLoaderData: () => ({}),
    useNavigation: () => ({ state: "idle" }),
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

import { loader } from "~/routes/admin.sales";

let calls: string[] = [];

function stubApi(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/me") {
        return Response.json({ success: true, data: { id: "u-1", role: "admin", shop_id: "shop-1" } });
      }
      calls.push(`${url.pathname}${url.search}`);
      return Response.json({ success: true, data: [] });
    }),
  );
}

async function openPage(path: string): Promise<{ date: string; calls: string[] }> {
  stubApi();
  const res = (await loader({
    request: new Request(`https://pivotparlor.com${path}`, { headers: { Cookie: "pp_session=tok.abc.123" } }),
    params: {},
    context: { env: { API_URL: "https://api.test" } },
  } as never)) as Response;
  const body = (await res.json()) as { date: string };
  return { date: body.date, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("admin sales page", () => {
  it("at 00:30 London in summer, opens on the shop's date, not UTC's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T23:30:00Z"));
    expect(await openPage("/admin/sales")).toEqual({
      date: "2026-07-02",
      calls: ["/api/shops/shop-1/sales?date=2026-07-02"],
    });
  });

  it("keeps a date the page was asked for (control)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T23:30:00Z"));
    expect(await openPage("/admin/sales?date=2026-06-30")).toEqual({
      date: "2026-06-30",
      calls: ["/api/shops/shop-1/sales?date=2026-06-30"],
    });
  });
});
