/**
 * Owner review (migration 049): the shop page's ?preview=candidate mode and
 * the dashboard's BFF route. The Worker decides who may read or act on a
 * pending version; these tests pin what the web does with its answers:
 * a reviewer sees the pending version, privately; everyone else, and every
 * failure, gets the public site exactly as before, with no extra request for
 * ordinary visitors.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@remix-run/react", () => ({ Outlet: () => null, useLoaderData: () => null }));
vi.mock("~/components/ErrorScreen", () => ({ ErrorScreen: () => null }));
import { headers as shopHeaders, loader, PREVIEW_HEADERS } from "~/routes/$shopSlug";
import { action as candidateAction, loader as candidateLoader } from "~/routes/api.shops.$shopId.site-candidate";
import { formatMadeAt } from "~/lib/siteCandidate";

const API = "https://api.test";
const SHOP = "shop-1";
const SLUG = "real-barber";
const ctx = { env: { API_URL: API } };

/** An unsigned JWT-shaped token; the web only decodes it to pick a link. */
function tokenFor(role: string) {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u1", role, exp: 4102444800 })}.sig`;
}

type CandidateMode = "ok" | "forbidden" | "none" | "down";

function fakeApi(opts: { candidate: CandidateMode; websiteStatus?: string }) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ success: false, error }), { status, headers: { "Content-Type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, auth: h.get("Authorization") });
    const path = url.slice(API.length);
    if (path === `/api/shops/${SLUG}`) return ok({ id: SHOP, name: "Real Barber", slug: SLUG });
    if (path === `/api/shops/${SLUG}/site`)
      return ok({ template: "classic", headline: "Live headline", tagline: "", about: "", services: [], website_status: opts.websiteStatus ?? "live", catalog_images: [], hero_image_url: null, logo_url: null });
    if (path === `/api/shops/${SLUG}/services`)
      return ok([{ id: "svc-1", name: "Skin fade", description: "Live copy.", durationMinutes: 40, price_pence: 2400, category: "Cuts" }]);
    if (path === `/api/shops/${SHOP}/site-candidate`) {
      if (opts.candidate === "forbidden") return fail(403, "Forbidden");
      if (opts.candidate === "none") return fail(404, "No new version is waiting for review");
      if (opts.candidate === "down") throw new Error("network down");
      return ok({
        job_id: "job-A",
        created_at: "2026-11-06T10:00:00Z",
        services_unchanged: true,
        site: { template: "classic", headline: "New headline", tagline: "", about: "", services: [], website_status: opts.websiteStatus ?? "live", catalog_images: ["https://img.test/new-fade.png"], hero_image_url: null, logo_url: null },
        services: [{ id: "svc-1", name: "Skin fade", description: "New copy.", durationMinutes: 40, price_pence: 2400, category: "Cuts" }],
      });
    }
    if (path.startsWith(`/api/shops/${SLUG}/`)) return ok([]); // booking-staff, reviews, settings
    return fail(500, `unexpected ${path}`);
  });
  return calls;
}

function shopRequest(opts: { preview?: boolean; role?: string } = {}) {
  const url = `https://web.test/${SLUG}${opts.preview ? "?preview=candidate" : ""}`;
  const headers: Record<string, string> = {};
  if (opts.role) headers.Cookie = `pp_session=${tokenFor(opts.role)}`;
  return loader({ params: { shopSlug: SLUG }, context: ctx, request: new Request(url, { headers }) } as never);
}

/** The shop loader's JSON as these tests read it (the real type is a union with the demo fixture). */
type ShopJson = {
  site: { headline: string };
  commercialServices: Array<{ name: string; description?: string; image_url?: string }>;
  preview: { created_at: string; services_unchanged: boolean; dashboard_href: string } | null;
};
const readShop = async (res: Response) => (await res.json()) as unknown as ShopJson;

afterEach(() => vi.restoreAllMocks());

describe("shop page ?preview=candidate", () => {
  it("shows a reviewer the pending version, privately and unindexed", async () => {
    const calls = fakeApi({ candidate: "ok" });
    const res = await shopRequest({ preview: true, role: "admin" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const data = await readShop(res);
    expect(data.site.headline).toBe("New headline");
    expect(data.commercialServices[0]).toMatchObject({ name: "Skin fade", description: "New copy.", image_url: "https://img.test/new-fade.png" });
    expect(data.preview).toMatchObject({ created_at: "2026-11-06T10:00:00Z", services_unchanged: true, dashboard_href: "/admin" });
    const candidateCall = calls.find((c) => c.url.endsWith("/site-candidate"))!;
    expect(candidateCall.auth).toMatch(/^Bearer /);
    // The candidate carries its own services; the live list is not fetched.
    expect(calls.some((c) => c.url.endsWith(`/api/shops/${SLUG}/services`))).toBe(false);
  });

  it("links a developer to the shop's dev page", async () => {
    fakeApi({ candidate: "ok" });
    const data = await readShop(await shopRequest({ preview: true, role: "developer" }));
    expect(data.preview?.dashboard_href).toBe(`/dev/shops/${SHOP}`);
  });

  it.each(["forbidden", "none", "down"] as const)("falls back to the public site when the pending version is %s", async (mode) => {
    fakeApi({ candidate: mode });
    const res = await shopRequest({ preview: true, role: "customer" });
    expect(res.headers.get("Cache-Control")).toBeNull();
    const data = await readShop(res);
    expect(data.site.headline).toBe("Live headline");
    expect(data.commercialServices[0].description).toBe("Live copy.");
    expect(data.preview).toBeNull();
  });

  it("never asks for a pending version without a session, or without the flag", async () => {
    let calls = fakeApi({ candidate: "ok" });
    await shopRequest({ preview: true });
    expect(calls.some((c) => c.url.includes("site-candidate"))).toBe(false);
    vi.restoreAllMocks();

    calls = fakeApi({ candidate: "ok" });
    const data = await readShop(await shopRequest({ role: "admin" }));
    expect(calls.some((c) => c.url.includes("site-candidate"))).toBe(false);
    expect(data.site.headline).toBe("Live headline");
  });

  it("lets a reviewer preview a paused site, which stays unavailable to the public", async () => {
    fakeApi({ candidate: "ok", websiteStatus: "paused" });
    const res = await shopRequest({ preview: true, role: "admin" });
    expect(res.status).toBe(200);
    vi.restoreAllMocks();

    fakeApi({ candidate: "ok", websiteStatus: "paused" });
    await expect(shopRequest()).rejects.toMatchObject({ status: 503 });
  });

  it("passes only the preview headers from the loader to the document", () => {
    const loaderHeaders = new Headers({ ...PREVIEW_HEADERS, "X-Other": "1" });
    const out = shopHeaders({ loaderHeaders, parentHeaders: new Headers({ "X-Parent": "p" }) } as never) as Headers;
    expect(out.get("Cache-Control")).toBe("private, no-store");
    expect(out.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(out.get("X-Parent")).toBe("p");
    expect(out.get("X-Other")).toBeNull();
    const plain = shopHeaders({ loaderHeaders: new Headers(), parentHeaders: new Headers() } as never) as Headers;
    expect(plain.get("Cache-Control")).toBeNull();
  });
});

describe("BFF /api/shops/:shopId/site-candidate", () => {
  const req = (init: RequestInit & { role?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.role) headers.set("Cookie", `pp_session=${tokenFor(init.role)}`);
    return new Request(`https://web.test/api/shops/${SHOP}/site-candidate`, { ...init, headers });
  };
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("summarises the pending version for the card, and marks 'nothing waiting' as normal", async () => {
    fakeApi({ candidate: "ok" });
    const ok = await (await candidateLoader({ params: { shopId: SHOP }, context: ctx, request: req({ role: "admin" }) } as never)).json();
    expect(ok).toEqual({
      success: true,
      data: { job_id: "job-A", created_at: "2026-11-06T10:00:00Z", services_unchanged: true, headline: "New headline" },
    });
    vi.restoreAllMocks();

    fakeApi({ candidate: "none" });
    const none = await candidateLoader({ params: { shopId: SHOP }, context: ctx, request: req({ role: "admin" }) } as never);
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ success: false, none: true });
    vi.restoreAllMocks();

    fakeApi({ candidate: "forbidden" });
    const forbidden = await candidateLoader({ params: { shopId: SHOP }, context: ctx, request: req({ role: "staff" }) } as never);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).not.toHaveProperty("none");
  });

  it("refuses without a session before calling the API", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const res = await candidateLoader({ params: { shopId: SHOP }, context: ctx, request: req() } as never);
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps Publish and Discard onto the API, carrying the previewed version id", async () => {
    const calls: Array<{ method: string; url: string; body: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : null });
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const publish = await candidateAction({
      params: { shopId: SHOP },
      context: ctx,
      request: req({ method: "POST", body: form({ intent: "publish", job_id: "job-A" }), role: "admin" }),
    } as never);
    expect(await publish.json()).toEqual({ success: true, intent: "publish" });
    const discard = await candidateAction({
      params: { shopId: SHOP },
      context: ctx,
      request: req({ method: "POST", body: form({ intent: "discard", job_id: "job-A" }), role: "admin" }),
    } as never);
    expect(await discard.json()).toEqual({ success: true, intent: "discard" });
    expect(calls).toEqual([
      { method: "POST", url: `${API}/api/shops/${SHOP}/site-candidate/publish`, body: JSON.stringify({ job_id: "job-A" }) },
      { method: "DELETE", url: `${API}/api/shops/${SHOP}/site-candidate?job_id=job-A`, body: null },
    ]);
  });

  it("passes the API's refusal through and rejects unknown actions without calling it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "A newer version replaced the one you previewed." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const conflict = await candidateAction({
      params: { shopId: SHOP },
      context: ctx,
      request: req({ method: "POST", body: form({ intent: "publish", job_id: "job-OLD" }), role: "admin" }),
    } as never);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error?: string }).error).toMatch(/newer version/);

    fetch.mockClear();
    const unknown = await candidateAction({
      params: { shopId: SHOP },
      context: ctx,
      request: req({ method: "POST", body: form({ intent: "delete-shop", job_id: "job-A" }), role: "admin" }),
    } as never);
    expect(unknown.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("formatMadeAt", () => {
  it("reads UK time, including across the clock change", () => {
    expect(formatMadeAt("2026-11-06T10:05:00Z")).toBe("6 Nov, 10:05");
    expect(formatMadeAt("2026-07-06T10:05:00Z")).toBe("6 Jul, 11:05");
    expect(formatMadeAt("")).toBe("");
    expect(formatMadeAt("nonsense")).toBe("");
  });
});
