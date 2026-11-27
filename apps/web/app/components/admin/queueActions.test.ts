/** The walk-in queue page's loader and action against a stubbed API. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the loader and action run here; the page's UI imports are stubbed (as
// app/lib/adminSalesDay.test.ts does).
vi.mock("react-router", async (importOriginal) => {
  const Stub = () => null;
  return {
    ...(await importOriginal<typeof import("react-router")>()),
    Form: Stub,
    Link: Stub,
    useFetcher: () => ({ state: "idle", data: undefined }),
    useLoaderData: () => ({}),
    useRevalidator: () => ({ state: "idle", revalidate: () => undefined }),
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

import { action, loader } from "~/routes/admin.queue";
import { asResponse } from "~/lib/testing/asResponse";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];

/** /auth/me answers as `role`; every other call is recorded and answered by `answer`. */
function stubApi(role: "admin" | "developer", answer: (call: Call) => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/me") {
        return Response.json({
          success: true,
          data: { id: "u-1", role, shop_id: role === "admin" ? "shop-1" : null },
        });
      }
      const call: Call = {
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      return answer(call);
    }),
  );
}

function post(fields: Record<string, string>, path = "/admin/queue"): Request {
  return new Request(`https://pivotparlor.com${path}`, {
    method: "POST",
    headers: { Cookie: "pp_session=tok.abc.123", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function run(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = asResponse(
    await action({ request, params: {}, context: { env: { API_URL: "https://api.test" } } } as never),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("walk-in queue: add a walk-in", () => {
  it("posts the trimmed name and service to the admin's own shop", async () => {
    stubApi("admin", () => Response.json({ success: true, data: { id: "w-9", position: 4 } }, { status: 201 }));
    // A shopId in the form is ignored for an admin: they work on their own shop.
    const result = await run(post({ intent: "addWalkin", name: "  Sam Carter ", service: " Skin fade ", shopId: "shop-other" }));
    expect(calls).toEqual([
      { method: "POST", path: "/api/shops/shop-1/walkin", body: { name: "Sam Carter", service: "Skin fade" } },
    ]);
    expect(result).toEqual({ status: 200, body: { ok: true, intent: "addWalkin", name: "Sam Carter", position: 4 } });
  });

  it("leaves the service out when none was given", async () => {
    stubApi("admin", () => Response.json({ success: true, data: { id: "w-9", position: 1 } }, { status: 201 }));
    await run(post({ intent: "addWalkin", name: "Jo", service: "  " }));
    expect(calls[0]?.body).toEqual({ name: "Jo" });
  });

  it("refuses an empty name without calling the API", async () => {
    stubApi("admin", () => Response.json({ success: true, data: {} }));
    const result = await run(post({ intent: "addWalkin", name: "   " }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, error: "Enter the customer's name." });
    expect(calls).toEqual([]);
  });

  it("answers the API's refusal as an error, not a thrown page", async () => {
    stubApi("admin", () => Response.json({ success: false, error: "Name is too long" }, { status: 400 }));
    const result = await run(post({ intent: "addWalkin", name: "Sam" }));
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(String(result.body.error)).toContain("Sam was not added to the queue");
  });

  it("a developer adds to the shop named in the page's URL", async () => {
    stubApi("developer", () => Response.json({ success: true, data: { id: "w-1", position: 1 } }, { status: 201 }));
    await run(post({ intent: "addWalkin", name: "Sam" }, "/admin/queue?shopId=shop-7"));
    expect(calls.map((c) => c.path)).toEqual(["/api/shops/shop-7/walkin"]);
  });
});

describe("walk-in queue: failed changes", () => {
  it("a refused status change answers ok:false with the entry it was for", async () => {
    stubApi("admin", () => Response.json({ success: false, error: "Entry not found" }, { status: 404 }));
    const result = await run(post({ intent: "updateStatus", entryId: "w-1", status: "waiting" }));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /api/shops/shop-1/walkin/w-1"]);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, intent: "updateStatus", entryId: "w-1" });
  });

  it("refuses a status the queue does not have, without calling the API", async () => {
    stubApi("admin", () => Response.json({ success: true, data: {} }));
    const result = await run(post({ intent: "updateStatus", entryId: "w-1", status: "vip" }));
    expect(result.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("walk-in queue: loading", () => {
  it("asks for skipped entries too, and builds the scan address from the request", async () => {
    stubApi("admin", (call) =>
      call.path.includes("/walkin")
        ? Response.json({ success: true, data: [{ id: "w-1", name: "Sam", status: "skipped" }] })
        : Response.json({ success: true, data: { slug: "fade-and-blade" } }),
    );
    const res = asResponse(
      await loader({
        request: new Request("https://staging.example.test/admin/queue", { headers: { Cookie: "pp_session=tok.abc.123" } }),
        params: {},
        context: { env: { API_URL: "https://api.test" } },
      } as never),
    );
    const body = (await res.json()) as { queue: unknown[]; walkinUrl: string; loadError: boolean };
    expect(calls.map((c) => c.path).sort()).toEqual(["/api/shops/shop-1", "/api/shops/shop-1/walkin?include_skipped=1"]);
    expect(body.queue).toHaveLength(1);
    expect(body.walkinUrl).toBe("https://staging.example.test/fade-and-blade/walkin");
    expect(body.loadError).toBe(false);
  });

  it("a failed queue load is flagged, never an empty queue", async () => {
    stubApi("admin", (call) =>
      call.path.includes("/walkin")
        ? Response.json({ success: false, error: "boom" }, { status: 500 })
        : Response.json({ success: true, data: { slug: "fade-and-blade" } }),
    );
    const res = asResponse(
      await loader({
        request: new Request("https://pivotparlor.com/admin/queue", { headers: { Cookie: "pp_session=tok.abc.123" } }),
        params: {},
        context: { env: { API_URL: "https://api.test" } },
      } as never),
    );
    expect(((await res.json()) as { loadError: boolean }).loadError).toBe(true);
  });
});
