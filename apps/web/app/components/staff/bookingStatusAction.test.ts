/** The staff booking page's action: the one place "Start" and "Complete"
 *  reach the API from (the Today screen, the bookings list and the booking's
 *  own page all post to it). Lives outside routes/ so the router never mounts
 *  it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the loader and action run here; the page's screen parts are stubbed.
vi.mock("react-router", async (importOriginal) => {
  const Stub = () => null;
  return {
    ...(await importOriginal<typeof import("react-router")>()),
    Form: Stub,
    Link: Stub,
    useFetcher: () => ({ state: "idle", submit: () => undefined }),
    useLoaderData: () => ({}),
    useLocation: () => ({ pathname: "/", search: "" }),
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useRouteError: () => null,
  };
});

import * as bookingPage from "~/routes/staff.bookings_.$bookingId";
import { asResponse } from "~/lib/testing/asResponse";

type Role = "staff" | "developer" | "customer";

const API_URL = "https://api.test";
const context = { env: { API_URL } };

let calls: Array<{ method: string; path: string; body: unknown }> = [];

/** Stubs the API: /auth/me answers as `role`; every other call is recorded and answered by `answer`. */
function stubApi(role: Role, answer: () => Response = () => Response.json({ success: true })) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/me") {
        return Response.json({ success: true, data: { id: "u-1", role, shop_id: "shop-1" } });
      }
      calls.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return answer();
    }),
  );
}

function post(fields: Record<string, string> | null, bookingId = "b-1") {
  const request = new Request(`https://pivotparlor.com/staff/bookings/${bookingId}`, {
    method: "POST",
    headers: { Cookie: "pp_session=tok.abc.123" },
    body: fields ? new URLSearchParams(fields) : JSON.stringify({ status: "completed" }),
  });
  return bookingPage.action({ request, context, params: { bookingId } } as never);
}

async function answerOf(result: unknown): Promise<{ status: number; body: { ok: boolean; error?: string; status?: string } }> {
  const res = asResponse(result);
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; status?: string } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("staff booking page: start and complete", () => {
  it.each(["in_progress", "completed"])("sends %s to the staff member's own status route", async (status) => {
    stubApi("staff");
    const { status: http, body } = await answerOf(await post({ intent: "status", status }));
    expect(http).toBe(200);
    expect(body).toEqual({ ok: true, status });
    expect(calls).toEqual([{ method: "PUT", path: "/api/staff/me/bookings/b-1/status", body: { status } }]);
  });

  it("refuses any other status without calling the API (staff cannot cancel or mark a no-show)", async () => {
    stubApi("staff");
    for (const status of ["cancelled", "no_show", "confirmed", ""]) {
      const { status: http, body } = await answerOf(await post({ intent: "status", status }));
      expect(http).toBe(400);
      expect(body.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a developer: Staff View is read-only for them", async () => {
    stubApi("developer");
    const { status: http, body } = await answerOf(await post({ intent: "status", status: "completed" }));
    expect(http).toBe(403);
    expect(body.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("sends anyone who is not staff away before reading the form", async () => {
    stubApi("customer");
    const thrown = await post({ intent: "status", status: "completed" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect(calls).toEqual([]);
  });

  it("refuses an id that is not a plain id, so it never reaches an API path", async () => {
    stubApi("staff");
    const { status: http } = await answerOf(await post({ intent: "status", status: "completed" }, "..%2Fshops"));
    expect(http).toBe(404);
    expect(calls).toEqual([]);
  });

  it("answers a body that is not a form with a 400 and calls no API", async () => {
    stubApi("staff");
    const { status: http, body } = await answerOf(await post(null));
    expect(http).toBe(400);
    expect(body.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("passes on the API's own refusal, with its status and its words", async () => {
    stubApi("staff", () => Response.json({ success: false, error: "That time is now taken." }, { status: 409 }));
    const { status: http, body } = await answerOf(await post({ intent: "status", status: "in_progress" }));
    expect(http).toBe(409);
    expect(body).toEqual({ ok: false, error: "That time is now taken." });
  });

  it("says what to do when the API is down, instead of its raw error", async () => {
    stubApi("staff", () => new Response("upstream exploded", { status: 500 }));
    const { status: http, body } = await answerOf(await post({ intent: "status", status: "completed" }));
    expect(http).toBe(502);
    expect(body.error).toBe("We couldn't complete this booking. Check your connection and try again.");
  });
});

describe("staff booking page: loader", () => {
  const get = (search = "") =>
    bookingPage.loader({
      request: new Request(`https://pivotparlor.com/staff/bookings/b-1${search}`, {
        headers: { Cookie: "pp_session=tok.abc.123" },
      }),
      context,
      params: { bookingId: "b-1" },
    } as never);

  it("a missing booking is a 404, not a failed load", async () => {
    stubApi("staff", () => Response.json({ success: false, error: "Booking not found" }, { status: 404 }));
    const thrown = await get().then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("a failed load is reported as one, never as an empty booking", async () => {
    stubApi("staff", () => new Response("down", { status: 503 }));
    const data = (await asResponse(await get()).json()) as { booking: unknown; loadError: boolean };
    expect(data.loadError).toBe(true);
    expect(data.booking).toBeNull();
  });

  it("a developer reads the staff member they chose, read-only", async () => {
    stubApi("developer", () => Response.json({ success: true, data: { id: "b-1" } }));
    const data = (await asResponse(await get("?shopId=shop-1&staffId=staff-9")).json()) as { readOnly: boolean };
    expect(data.readOnly).toBe(true);
    expect(calls).toEqual([{ method: "GET", path: "/api/staff/me/bookings/b-1?staffId=staff-9", body: undefined }]);
  });
});
