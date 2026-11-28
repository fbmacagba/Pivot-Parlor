// @vitest-environment node
// (jsdom's File does not survive a Request body; these tests post real files.)
/** Refund review on the owner's pages: Sales and Bookings can only FILE a
 *  refund request (a reason is required), and only the Refunds page approves
 *  one, for the booking or sale the API says it was filed for. Lives beside
 *  the admin components, so the router never mounts it as a route. */
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
vi.mock("@radix-ui/react-dialog", emptyModule);
vi.mock("@radix-ui/react-slot", emptyModule);

import * as bookingsPage from "~/routes/admin.bookings";
import * as refundsPage from "~/routes/admin.refunds";
import * as salesPage from "~/routes/admin.sales";
import { asResponse } from "~/lib/testing/asResponse";
import { refundEvidenceProblem, refundReasonProblem, selfApprovalBlocked } from "~/lib/refundRequests";

type Call = { method: string; path: string; body: unknown; auth: string | null };
let calls: Call[] = [];

/** A form body as plain fields; a file reads as its name, type and size. */
function fieldsOf(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  form.forEach((value, key) => {
    out[key] = typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size };
  });
  return out;
}

/** Answers /auth/me as an admin of shop-1, and every API call from `answers`
 *  (keyed by path without the query string). A number is that HTTP status. */
function stubApi(answers: Record<string, unknown> = {}): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/me") {
        return Response.json({ success: true, data: { id: "u-1", role: "admin", shop_id: "shop-1" } });
      }
      const body =
        init?.body instanceof FormData
          ? fieldsOf(init.body)
          : typeof init?.body === "string"
            ? JSON.parse(init.body)
            : undefined;
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, body, auth: headers.get("Authorization") });
      const answer = answers[url.pathname];
      if (typeof answer === "number") {
        return Response.json({ success: false, error: "The API said no" }, { status: answer });
      }
      return Response.json({ success: true, data: answer ?? [] });
    }),
  );
}

const COOKIE = { Cookie: "pp_session=tok.abc.123" };
type Handler = (args: never) => unknown;

async function post(
  page: { action: Handler },
  path: string,
  fields: Record<string, string | File>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const res = asResponse(
    await page.action({
      request: new Request(`https://pivotparlor.com${path}`, { method: "POST", headers: COOKIE, body: form }),
      params: {},
      context: { env: { API_URL: "https://api.test" } },
    } as never),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const writes = () => calls.filter((c) => c.method !== "GET");
const REASON = "Customer brought it back sealed the next morning";
const LINES = JSON.stringify([{ sale_item_id: "item-1", quantity: 1, restock: true }]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what a refund request must carry", () => {
  it("needs a reason that says something", () => {
    expect(refundReasonProblem("")).toMatch(/at least 10/);
    expect(refundReasonProblem("  broken  ")).toMatch(/at least 10/);
    expect(refundReasonProblem(REASON)).toBeNull();
    expect(refundReasonProblem("x".repeat(1001))).toMatch(/under 1000/);
  });

  it("takes an image or a PDF up to 5MB as evidence, or nothing", () => {
    expect(refundEvidenceProblem(null)).toBeNull();
    expect(refundEvidenceProblem({ size: 0, type: "" })).toBeNull();
    expect(refundEvidenceProblem({ size: 1000, type: "image/jpeg" })).toBeNull();
    expect(refundEvidenceProblem({ size: 1000, type: "application/pdf" })).toBeNull();
    expect(refundEvidenceProblem({ size: 1000, type: "text/html" })).toMatch(/PNG, JPEG or WebP image, or a PDF/);
    expect(refundEvidenceProblem({ size: 5 * 1024 * 1024 + 1, type: "image/png" })).toMatch(/over 5MB/);
  });
});

describe("approving your own request", () => {
  it("is blocked only for the person who filed it, and only without evidence", () => {
    expect(selfApprovalBlocked({ requested_by: "u-1", has_evidence: false }, "u-1")).toBe(true);
    expect(selfApprovalBlocked({ requested_by: "u-1", has_evidence: true }, "u-1")).toBe(false);
    expect(selfApprovalBlocked({ requested_by: "u-2", has_evidence: false }, "u-1")).toBe(false);
    expect(selfApprovalBlocked({ requested_by: null, has_evidence: false }, "u-1")).toBe(false);
  });

  it("is never blocked for a shop cancellation", () => {
    expect(selfApprovalBlocked({ requested_by: "u-1", has_evidence: false, shop_cancelled: true }, "u-1")).toBe(false);
    expect(selfApprovalBlocked({ requested_by: "u-1", has_evidence: false, shop_cancelled: false }, "u-1")).toBe(true);
  });

  it("the Refunds page is told who is looking", async () => {
    stubApi();
    const res = asResponse(
      await refundsPage.loader({
        request: new Request("https://pivotparlor.com/admin/refunds", { headers: COOKIE }),
        params: {},
        context: { env: { API_URL: "https://api.test" } },
      } as never),
    );
    expect(((await res.json()) as { userId: string }).userId).toBe("u-1");
  });

  it("shows the API's refusal of a self-approval", async () => {
    stubApi({
      "/api/shops/shop-1/refund-requests": [{ id: "rr-1", kind: "sale", sale_id: "sale-1", status: "pending" }],
      "/api/shops/shop-1/sales/sale-1/refund": 403,
    });
    const res = await post(refundsPage, "/admin/refunds", { intent: "approve", requestId: "rr-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("The API said no");
  });
});

describe("sales page", () => {
  it("files a request with the lines, the reason and the evidence, and refunds nothing", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": { id: "rr-1", amount_pence: 1000 } });
    const evidence = new File([new Uint8Array([1, 2, 3])], "receipt.png", { type: "image/png" });
    const res = await post(salesPage, "/admin/sales", { saleId: "sale-1", lines: LINES, reason: `  ${REASON} `, evidence });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toMatch(/Refund request for £10\.00 filed\. No money has moved/);
    expect(writes()).toEqual([
      {
        method: "POST",
        path: "/api/shops/shop-1/refund-requests",
        auth: "Bearer tok.abc.123",
        body: {
          kind: "sale",
          sale_id: "sale-1",
          lines: LINES,
          reason: REASON,
          evidence: { name: "receipt.png", type: "image/png", size: 3 },
        },
      },
    ]);
  });

  it("refuses a missing or thin reason, and a file that is not an image or PDF, before calling the API", async () => {
    stubApi();
    expect((await post(salesPage, "/admin/sales", { saleId: "sale-1", lines: LINES, reason: "" })).status).toBe(400);
    expect((await post(salesPage, "/admin/sales", { saleId: "sale-1", lines: LINES, reason: "damaged" })).status).toBe(400);
    const html = new File(["<p>x</p>"], "note.html", { type: "text/html" });
    const bad = await post(salesPage, "/admin/sales", { saleId: "sale-1", lines: LINES, reason: REASON, evidence: html });
    expect(bad.status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it("shows the API's own refusal, such as a request already waiting", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": 409 });
    const res = await post(salesPage, "/admin/sales", { saleId: "sale-1", lines: LINES, reason: REASON });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("The API said no");
  });
});

describe("bookings page", () => {
  it("cancelling with a deposit keeps it; the form cannot ask for a refund", async () => {
    stubApi();
    await post(bookingsPage, "/admin/bookings", { bookingId: "b-1", status: "cancelled", refund_deposit: "0" });
    // The old "refund the deposit" form value is ignored: no refund flag is sent at all.
    await post(bookingsPage, "/admin/bookings", { bookingId: "b-2", status: "cancelled", refund_deposit: "1" });
    expect(writes().map((c) => [c.path, c.body])).toEqual([
      ["/api/shops/shop-1/bookings/b-1/status", { status: "cancelled", refund_deposit: false }],
      ["/api/shops/shop-1/bookings/b-2/status", { status: "cancelled" }],
    ]);
  });

  it("files the request first, then cancels keeping the deposit", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": { id: "rr-2", amount_pence: 1250 } });
    const res = await post(bookingsPage, "/admin/bookings", {
      intent: "request_refund",
      bookingId: "b-1",
      cancel: "1",
      reason: REASON,
    });
    expect(res.body).toEqual({ ok: true });
    expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/shops/shop-1/refund-requests", { kind: "deposit", booking_id: "b-1", reason: REASON }],
      ["PUT", "/api/shops/shop-1/bookings/b-1/status", { status: "cancelled", refund_deposit: false }],
    ]);
  });

  it("leaves the booking alone when the request is refused or has no reason", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": 400 });
    const refused = await post(bookingsPage, "/admin/bookings", {
      intent: "request_refund",
      bookingId: "b-1",
      cancel: "1",
      reason: REASON,
    });
    expect(refused.status).toBe(400);
    const noReason = await post(bookingsPage, "/admin/bookings", { intent: "request_refund", bookingId: "b-1", cancel: "1", reason: "" });
    expect(noReason.status).toBe(400);
    expect(writes().map((c) => c.path)).toEqual(["/api/shops/shop-1/refund-requests"]);
  });

  it("the shop cancelling files a shop cancellation, then cancels with the refund under that request", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": { id: "rr-shop", amount_pence: 1250 } });
    const res = await post(bookingsPage, "/admin/bookings", { intent: "shop_cancel", bookingId: "b-1" });
    expect(res.body).toEqual({ ok: true });
    expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/shops/shop-1/refund-requests", { kind: "deposit", booking_id: "b-1", shop_cancelled: "1" }],
      [
        "PUT",
        "/api/shops/shop-1/bookings/b-1/status",
        { status: "cancelled", refund_deposit: true, refund_request_id: "rr-shop" },
      ],
    ]);
  });

  it("the shop cancelling leaves the booking alone when the request is refused", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": 400 });
    const res = await post(bookingsPage, "/admin/bookings", { intent: "shop_cancel", bookingId: "b-1" });
    expect(res.status).toBe(400);
    expect(writes().map((c) => c.path)).toEqual(["/api/shops/shop-1/refund-requests"]);
  });

  it("the shop cancelling says where the request waits when the refund fails", async () => {
    stubApi({
      "/api/shops/shop-1/refund-requests": { id: "rr-shop", amount_pence: 1250 },
      "/api/shops/shop-1/bookings/b-1/status": 502,
    });
    const res = await post(bookingsPage, "/admin/bookings", { intent: "shop_cancel", bookingId: "b-1" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/did not go through.*Refunds page/);
  });

  it("a request on an already cancelled booking changes no status", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": { id: "rr-3", amount_pence: 1250 } });
    await post(bookingsPage, "/admin/bookings", { intent: "request_refund", bookingId: "b-9", reason: REASON });
    expect(writes().map((c) => c.path)).toEqual(["/api/shops/shop-1/refund-requests"]);
  });
});

describe("refunds page", () => {
  const SALE_REQUEST = { id: "rr-sale", kind: "sale", sale_id: "sale-7", booking_id: null, amount_pence: 1000, status: "pending" };
  const DEPOSIT_REQUEST = { id: "rr-dep", kind: "deposit", sale_id: null, booking_id: "b-4", amount_pence: 1250, status: "pending" };

  it("approving a sale request refunds the sale the API names, not one from the form", async () => {
    stubApi({
      "/api/shops/shop-1/refund-requests": [SALE_REQUEST, DEPOSIT_REQUEST],
      "/api/shops/shop-1/sales/sale-7/refund": { customer_refund_pence: 1000, status: "completed" },
    });
    const res = await post(refundsPage, "/admin/refunds", {
      intent: "approve",
      requestId: "rr-sale",
      saleId: "sale-OTHER",
      bookingId: "b-OTHER",
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Approved\. £10\.00 is recorded as refunded/);
    expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/shops/shop-1/sales/sale-7/refund", { refund_request_id: "rr-sale" }],
    ]);
  });

  it("approving a deposit request cancels with the refund and the request's id", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": [SALE_REQUEST, DEPOSIT_REQUEST] });
    const res = await post(refundsPage, "/admin/refunds", { intent: "approve", requestId: "rr-dep" });
    expect(res.status).toBe(200);
    expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
      [
        "PUT",
        "/api/shops/shop-1/bookings/b-4/status",
        { status: "cancelled", refund_deposit: true, refund_request_id: "rr-dep" },
      ],
    ]);
  });

  it("refunds nothing for a request that is no longer waiting", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests": [DEPOSIT_REQUEST] });
    const res = await post(refundsPage, "/admin/refunds", { intent: "approve", requestId: "rr-gone" });
    expect(res.status).toBe(409);
    expect(writes()).toEqual([]);
  });

  it("adding evidence sends only the file, to the request named", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests/rr-1/evidence": { id: "rr-1", has_evidence: true } });
    const evidence = new File([new Uint8Array([1, 2])], "text.png", { type: "image/png" });
    const res = await post(refundsPage, "/admin/refunds", { intent: "add_evidence", requestId: "rr-1", evidence });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/shops/shop-1/refund-requests/rr-1/evidence", { evidence: { name: "text.png", type: "image/png", size: 2 } }],
    ]);
  });

  it("adding evidence needs a file of an allowed kind and a real request id, and shows the API's refusal", async () => {
    stubApi({ "/api/shops/shop-1/refund-requests/rr-1/evidence": 409 });
    const png = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const html = new File(["<p>x</p>"], "note.html", { type: "text/html" });
    expect((await post(refundsPage, "/admin/refunds", { intent: "add_evidence", requestId: "rr-1" })).status).toBe(400);
    expect((await post(refundsPage, "/admin/refunds", { intent: "add_evidence", requestId: "rr-1", evidence: html })).status).toBe(400);
    expect((await post(refundsPage, "/admin/refunds", { intent: "add_evidence", requestId: "../x", evidence: png })).status).toBe(400);
    expect(writes()).toEqual([]);

    const refused = await post(refundsPage, "/admin/refunds", { intent: "add_evidence", requestId: "rr-1", evidence: png });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("The API said no");
  });

  it("declining sends the note and moves no money", async () => {
    stubApi();
    const res = await post(refundsPage, "/admin/refunds", { intent: "decline", requestId: "rr-sale", note: " Outside the window " });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/No money has moved/);
    expect(writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/shops/shop-1/refund-requests/rr-sale/decline", { note: "Outside the window" }],
    ]);
  });

  it("refuses an unknown action and a malformed request id without calling the API", async () => {
    stubApi();
    expect((await post(refundsPage, "/admin/refunds", { intent: "pay", requestId: "rr-sale" })).status).toBe(400);
    expect((await post(refundsPage, "/admin/refunds", { intent: "approve", requestId: "../sales" })).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it("shows the API's refusal when the refund fails, so the request stays waiting", async () => {
    stubApi({
      "/api/shops/shop-1/refund-requests": [SALE_REQUEST],
      "/api/shops/shop-1/sales/sale-7/refund": 502,
    });
    const res = await post(refundsPage, "/admin/refunds", { intent: "approve", requestId: "rr-sale" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("The API said no");
  });
});
