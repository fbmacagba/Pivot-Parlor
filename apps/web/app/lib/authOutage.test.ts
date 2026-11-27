/**
 * requireAuth sends a visitor to sign in only when their session is refused.
 * When the API itself is failing, signing in again cannot help and used to
 * bounce every signed-in owner to the sign-in form: that must be a 503 for
 * the page's error screen instead, with the session left alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAuth } from "./auth";

const API = "https://api.test";

function request(path: string, withSession = true): Request {
  return new Request(`https://pivotparlor.test${path}`, {
    headers: withSession ? { Cookie: "pp_session=a.b.c" } : {},
  });
}

function stubMe(response: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
}

async function thrown(run: Promise<unknown>): Promise<Response> {
  try {
    await run;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  throw new Error("expected requireAuth to throw a Response");
}

afterEach(() => vi.unstubAllGlobals());

describe("requireAuth when /auth/me fails", () => {
  it("sends a refused session to sign in, keeping the page and its query", async () => {
    stubMe(() => Response.json({ success: false, error: "Unauthorized" }, { status: 401 }));
    const res = await thrown(requireAuth(request("/admin/bookings?shopId=s1&status=pending"), API));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/login?redirect=${encodeURIComponent("/admin/bookings?shopId=s1&status=pending")}`,
    );
  });

  it("answers 503, not a sign-in redirect, when the API errors", async () => {
    stubMe(() => Response.json({ success: false, error: "boom" }, { status: 500 }));
    const res = await thrown(requireAuth(request("/admin"), API));
    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("answers 503 when the API returns a page that is not JSON", async () => {
    stubMe(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const res = await thrown(requireAuth(request("/staff"), API));
    expect(res.status).toBe(503);
  });

  it("answers 503 when the API cannot be reached at all", async () => {
    stubMe(() => {
      throw new TypeError("fetch failed");
    });
    const res = await thrown(requireAuth(request("/dev"), API));
    expect(res.status).toBe(503);
  });

  it("carries the person's and the shop's names from /auth/me", async () => {
    stubMe(() =>
      Response.json({
        success: true,
        data: { id: "u1", role: "admin", shop_id: "s1", name: " Sam Barber ", shop_name: "Fade House" },
      }),
    );
    const user = await requireAuth(request("/admin"), API);
    expect(user).toMatchObject({ sub: "u1", role: "admin", shop_id: "s1", name: "Sam Barber", shop_name: "Fade House" });
  });
});
