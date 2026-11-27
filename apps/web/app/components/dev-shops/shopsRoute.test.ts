/** The developer shops list's loader and its generate-site action, called
 *  directly against a stubbed API. Lives here rather than in routes/ so the
 *  router never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, loader } from "~/routes/dev.shops._index";
import { loader as overviewLoader } from "~/routes/dev._index";
import { loader as revenueLoader } from "~/routes/dev.revenue";
import { loader as enquiriesLoader } from "~/routes/dev.enquiries";
import { asResponse } from "~/lib/testing/asResponse";

const API_URL = "https://api.test";
const context = { env: { API_URL } };
const SESSION = "pp_session=tok.abc.123";

type Call = { url: string; method: string; headers: Headers; body: string | null };

/** Stubs the API. /auth/me answers as a developer; `answer` handles the rest. */
function stubApi(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${API_URL}/auth/me`) {
        return Response.json({ success: true, data: { id: "u-1", role: "developer", shop_id: null } });
      }
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

const get = (path: string, cookie = SESSION) =>
  new Request(`https://pivotparlor.com${path}`, { headers: { Cookie: cookie } });

async function read<T>(result: unknown): Promise<T> {
  return (await asResponse(result).json()) as T;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dev.shops loader", () => {
  it("says the load failed instead of answering with an empty list", async () => {
    stubApi(() => Response.json({ success: false, error: "boom" }, { status: 500 }));
    const data = await read<{ shops: unknown[]; loadError: boolean }>(
      await loader({ request: get("/dev/shops"), context, params: {} } as never),
    );
    expect(data).toMatchObject({ shops: [], loadError: true });
  });

  it("answers with the shops and the public origin every link is built from", async () => {
    stubApi(() => Response.json({ success: true, data: [{ id: "s1", name: "Fade", booking_count: 3 }] }));
    const data = await read<{ shops: Array<{ id: string }>; loadError: boolean; publicOrigin: string }>(
      await loader({ request: get("/dev/shops?q=fade"), context, params: {} } as never),
    );
    expect(data.loadError).toBe(false);
    expect(data.shops).toEqual([{ id: "s1", name: "Fade", booking_count: 3 }]);
    expect(data.publicOrigin).toBe("https://pivotparlor.com");
  });

  // The test fixture used to be built into this page and served to anyone who
  // added the query string, in production too. Now the page only passes the
  // request on: the API decides, and serves a fixture only where they are on.
  it.each([
    ["the query string", "/dev/shops?e2e_stripe_shop_list=1", SESSION],
    ["the cookie", "/dev/shops", `${SESSION}; e2e_stripe_shop_list=1`],
  ])("holds no fixture of its own: %s only asks the API for one", async (_name, path, cookie) => {
    const calls = stubApi(() => Response.json({ success: true, data: [{ id: "real", name: "Real Shop" }] }));
    const data = await read<{ shops: Array<{ id: string; name: string }> }>(
      await loader({ request: get(path, cookie), context, params: {} } as never),
    );
    // What the API answered, here a real shop: never "E2E Unpaid Shop".
    expect(data.shops).toEqual([{ id: "real", name: "Real Shop" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_URL}/api/shops`);
    expect(calls[0]!.headers.get("X-E2E-Test-Mock-Stripe-List")).toBe("1");
  });

  it("sends no fixture header on an ordinary request", async () => {
    const calls = stubApi(() => Response.json({ success: true, data: [] }));
    await loader({ request: get("/dev/shops"), context, params: {} } as never);
    expect(calls[0]!.headers.get("X-E2E-Test-Mock-Stripe-List")).toBeNull();
  });
});

describe("dev.shops action: generate-site", () => {
  const post = (fields: Record<string, string>) =>
    new Request("https://pivotparlor.com/dev/shops?index", {
      method: "POST",
      headers: { Cookie: SESSION, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _action: "generate-site", ...fields }),
    });

  it("follows the run already going when the API answers 409 with its job id", async () => {
    const calls = stubApi(() =>
      Response.json(
        {
          success: false,
          error: "A site generation is already running for this shop.",
          code: "generation_in_progress",
          data: { job_id: "job-running" },
        },
        { status: 409 },
      ),
    );
    const data = await read<Record<string, unknown>>(
      await action({ request: post({ shopId: "s1", shopSlug: "fade-001" }), context, params: {} } as never),
    );
    expect(data).toMatchObject({
      success: true,
      generateJobId: "job-running",
      adopted: true,
      generateShopId: "s1",
      generateShopSlug: "fade-001",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_URL}/api/shops/s1/generate-site`);
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok.abc.123");
  });

  it("passes the shop page's palette and reuse-images choice through", async () => {
    const calls = stubApi(() => Response.json({ success: true, data: { jobId: "job-new", message: "queued" } }));
    const data = await read<Record<string, unknown>>(
      await action({
        request: post({
          shopId: "s1",
          shopSlug: "fade-001",
          skip_images: "1",
          color_primary: "#0D0D0D",
          color_accent: "#C9A84C",
        }),
        context,
        params: {},
      } as never),
    );
    expect(data).toMatchObject({ success: true, generateJobId: "job-new", adopted: false });
    expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({
      skip_images: true,
      color_primary: "#0D0D0D",
      color_accent: "#C9A84C",
    });
  });

  it("names the shop on a refusal, so its row can show the reason", async () => {
    stubApi(() => Response.json({ success: false, error: "Unknown text model: x" }, { status: 400 }));
    const data = await read<Record<string, unknown>>(
      await action({ request: post({ shopId: "s1", shopSlug: "fade-001" }), context, params: {} } as never),
    );
    expect(data).toMatchObject({ success: false, generateShopId: "s1", error: "Unknown text model: x" });
  });
});

describe("overview, revenue and enquiries loaders: a failed read is never a real-looking zero", () => {
  it("overview: stats that could not be read are null, and the enquiries read asks for 8", async () => {
    const calls = stubApi((call) =>
      call.url.includes("/api/dev/stats")
        ? Response.json({ success: false, error: "boom" }, { status: 500 })
        : Response.json({ success: true, data: [] }),
    );
    const data = await read<{ stats: unknown; enquiriesError: boolean }>(
      await overviewLoader({ request: get("/dev"), context, params: {} } as never),
    );
    expect(data.stats).toBeNull();
    expect(data.enquiriesError).toBe(false);
    expect(calls.map((c) => c.url)).toContain(`${API_URL}/api/contact?limit=8`);
  });

  it("revenue: a bad month in the address falls back to this month and says so", async () => {
    const calls = stubApi(() =>
      Response.json({
        success: true,
        data: { totals: { total_bookings: 1, total_gross_pence: 1000, total_commission_pence: 100 }, shops: [] },
      }),
    );
    const data = await read<{ year: number; month: number; adjusted: boolean; data: unknown }>(
      await revenueLoader({ request: get("/dev/revenue?year=abc&month=99"), context, params: {} } as never),
    );
    const now = new Date();
    expect(data).toMatchObject({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, adjusted: true });
    expect(data.data).not.toBeNull();
    // Never "NaN" on its way to the API.
    expect(calls.every((c) => /year=\d{4}&month=\d{1,2}$/.test(c.url))).toBe(true);
  });

  it("revenue: a failed read is null (the page shows a load error), and no year total is offered", async () => {
    stubApi(() => Response.json({ success: false, error: "boom" }, { status: 500 }));
    const data = await read<{ data: unknown; yearTotals: unknown }>(
      await revenueLoader({ request: get("/dev/revenue"), context, params: {} } as never),
    );
    expect(data.data).toBeNull();
    expect(data.yearTotals).toBeNull();
  });

  it("enquiries: a failed first page is a load error; a full page means there may be more", async () => {
    stubApi(() => Response.json({ success: false, error: "boom" }, { status: 500 }));
    const failed = await read<{ loadError: boolean; hasMore: boolean }>(
      await enquiriesLoader({ request: get("/dev/enquiries"), context, params: {} } as never),
    );
    expect(failed).toMatchObject({ loadError: true, hasMore: false });

    const full = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}` }));
    const calls = stubApi((call) =>
      Response.json({ success: true, data: call.url.includes("offset=0") ? full : full.slice(0, 40) }),
    );
    const more = await read<{ enquiries: unknown[]; hasMore: boolean; shown: number }>(
      await enquiriesLoader({ request: get("/dev/enquiries"), context, params: {} } as never),
    );
    expect(more).toMatchObject({ hasMore: true, shown: 100 });
    expect(more.enquiries).toHaveLength(100);
    expect(calls.map((c) => c.url)).toEqual([`${API_URL}/api/contact?limit=100&offset=0`]);

    const two = await read<{ enquiries: unknown[]; hasMore: boolean; shown: number }>(
      await enquiriesLoader({ request: get("/dev/enquiries?show=200"), context, params: {} } as never),
    );
    expect(two).toMatchObject({ hasMore: false, shown: 200 });
    expect(two.enquiries).toHaveLength(140);
  });
});
