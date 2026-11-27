// @vitest-environment node
// (jsdom's File does not survive a Request body; these tests post real files.)
/** The staff Refunds page: staff can FILE a refund request on a till sale and
 *  see their own requests. Nothing on it refunds, approves or declines. Lives
 *  beside the staff components, so the router never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-router", async (importOriginal) => {
  const Stub = () => null;
  return {
    ...(await importOriginal<typeof import("react-router")>()),
    Form: Stub,
    Link: Stub,
    isRouteErrorResponse: () => false,
    useFetcher: () => ({ state: "idle", submit: () => undefined, load: () => undefined }),
    useLoaderData: () => ({}),
    useLocation: () => ({ pathname: "/", search: "" }),
    useRouteError: () => null,
    useSearchParams: () => [new URLSearchParams(), () => undefined],
  };
});
const emptyModule = vi.hoisted(
  () => () =>
    new Proxy(
      {},
      {
        get: (_t, key) => (key === "then" ? undefined : () => null),
        has: (_t, key) => key !== "then",
      },
    ),
);
vi.mock("lucide-react", emptyModule);
vi.mock("@radix-ui/react-slot", emptyModule);

import * as page from "~/routes/staff.refunds";
import { asResponse } from "~/lib/testing/asResponse";

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];

function fieldsOf(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  form.forEach((value, key) => {
    out[key] = typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size };
  });
  return out;
}

/** Answers /auth/me as staff member u-staff of shop-1, and every API call
 *  from `answers` (keyed by path without the query string). */
function stubApi(answers: Record<string, unknown> = {}, role: "staff" | "developer" = "staff"): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/me") {
        return Response.json({
          success: true,
          data: { id: "u-staff", role, shop_id: role === "staff" ? "shop-1" : null },
        });
      }
      const body =
        init?.body instanceof FormData
          ? fieldsOf(init.body)
          : typeof init?.body === "string"
            ? JSON.parse(init.body)
            : undefined;
      calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, body });
      const answer = answers[url.pathname];
      if (typeof answer === "number") {
        return Response.json({ success: false, error: "The API said no" }, { status: answer });
      }
      return Response.json({ success: true, data: answer ?? [] });
    }),
  );
}

const COOKIE = { Cookie: "pp_session=tok.abc.123" };
const context = { env: { API_URL: "https://api.test" } };
const REASON = "Customer brought it back sealed the next morning";
const LINES = JSON.stringify([{ sale_item_id: "item-1", quantity: 1, restock: true }]);

/** A loader or action's answer as a Response, whether returned or thrown (a redirect). */
async function settle(run: () => unknown): Promise<Response> {
  try {
    return asResponse(await run());
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

function load(path: string): Promise<Response> {
  return settle(() =>
    page.loader({ request: new Request(`https://pivotparlor.com${path}`, { headers: COOKIE }), params: {}, context } as never),
  );
}

function post(path: string, fields: Record<string, string | File>): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return settle(() =>
    page.action({
      request: new Request(`https://pivotparlor.com${path}`, { method: "POST", headers: COOKIE, body: form }),
      params: {},
      context,
    } as never),
  );
}

const writes = () => calls.filter((c) => c.method !== "GET");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("staff Refunds page", () => {
  it("files a request for the staff member's own shop, with reason and evidence, and refunds nothing", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": { id: "rr-1", amount_pence: 1000 } });
    const evidence = new File([new Uint8Array([1, 2, 3])], "receipt.png", { type: "image/png" });
    // A shop named in the form is ignored: staff act for their own shop only.
    const res = await post("/staff/refunds", { shopId: "shop-other", saleId: "sale-1", lines: LINES, reason: REASON, evidence });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toMatch(/No money has moved/);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toBe("/api/shops/shop-1/refund-requests");
    expect(writes()[0].body).toMatchObject({
      kind: "sale",
      sale_id: "sale-1",
      lines: LINES,
      reason: REASON,
      evidence: { name: "receipt.png", type: "image/png", size: 3 },
    });
  });

  it("sends nothing without a reason, or without items", async () => {
    stubApi();
    expect((await post("/staff/refunds", { saleId: "sale-1", lines: LINES, reason: "broken" })).status).toBe(400);
    expect((await post("/staff/refunds", { saleId: "sale-1", lines: "[]", reason: REASON })).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it("passes on the API's refusal", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": 409 });
    const res = await post("/staff/refunds", { saleId: "sale-1", lines: LINES, reason: REASON });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("The API said no");
  });

  it("lists only the requests this person filed, and marks sales with a request waiting", async () => {
    stubApi({
      "/api/shops/shop-1/refund-requests": [
        { id: "rr-mine", kind: "sale", sale_id: "sale-1", status: "declined", requested_by: "u-staff" },
        { id: "rr-theirs", kind: "sale", sale_id: "sale-2", status: "pending", requested_by: "u-owner" },
        { id: "rr-theirs-done", kind: "sale", sale_id: "sale-3", status: "approved", requested_by: "u-owner" },
      ],
    });
    const res = await load("/staff/refunds?date=2026-11-20");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { myRequests: Array<{ id: string }>; pendingRefundSaleIds: string[]; shopId: string };
    expect(data.shopId).toBe("shop-1");
    expect(data.myRequests.map((r) => r.id)).toEqual(["rr-mine"]);
    expect(data.pendingRefundSaleIds).toEqual(["sale-2"]);
    expect(calls.map((c) => c.path)).toContain("/api/shops/shop-1/sales?date=2026-11-20");
    expect(writes()).toHaveLength(0);
  });

  it("says so when the requests did not load, without losing the sales", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": 500, "/api/shops/shop-1/sales": [{ id: "sale-1" }] });
    const data = (await (await load("/staff/refunds")).json()) as { myRequestsError: boolean; sales: unknown[]; loadError: boolean };
    expect(data.myRequestsError).toBe(true);
    expect(data.loadError).toBe(false);
    expect(data.sales).toHaveLength(1);
  });

  it("for a developer: sends them to Admin view's Sales, and files nothing for them", async () => {
    stubApi({}, "developer");
    const res = await load("/staff/refunds?shopId=shop-1&staffId=staff-9");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/sales?shopId=shop-1");

    const refused = await post("/staff/refunds?shopId=shop-1", { shopId: "shop-1", saleId: "sale-1", lines: LINES, reason: REASON });
    expect(refused.status).toBe(403);
    expect(writes()).toHaveLength(0);
  });
});
