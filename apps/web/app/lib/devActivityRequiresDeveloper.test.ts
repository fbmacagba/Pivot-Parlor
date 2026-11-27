/** The developer Activity page's own loader and action must refuse anyone who
 *  is not a developer before they reach the API. The `dev.tsx` layout's check
 *  does not run for a form POST, or for a data request that names only this
 *  route (`/dev/activity.data?_routes=routes%2Fdev.activity`), and the
 *  action forwards the irreversible audit "erase". Lives in lib/ rather than
 *  routes/ so the router never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the server handlers are under test, so the page's hooks and UI
// components are stubbed (as in portfolioDemo.test.ts): react-router's real
// server helpers (data, redirect) with the screen parts stubbed on top.
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Form: () => null,
  useActionData: () => undefined,
  useLoaderData: () => null,
  useNavigation: () => ({ state: "idle" }),
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));
vi.mock("~/components/ui/Badge", () => ({ Badge: () => null }));
vi.mock("~/components/ui/Button", () => ({ Button: () => null }));
vi.mock("~/components/ui/Input", () => ({ Input: () => null }));
vi.mock("~/components/audit/ErasureRequestDialog", () => ({ ErasureRequestDialog: () => null }));

import { action, loader } from "~/routes/dev.activity";
import { asResponse } from "~/lib/testing/asResponse";

const API_URL = "https://api.test";
const context = { env: { API_URL } };
const SESSION = "pp_session=tok.abc.123";

/** Stubs the API: /auth/me answers as `role` (null: refused); anything else succeeds. */
function stubApi(role: string | null): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url === `${API_URL}/auth/me`) {
        return role
          ? Response.json({ success: true, data: { id: "u-1", role, shop_id: null } })
          : Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
      }
      return Response.json({ success: true, data: { redact_after: null, entries: [], next_cursor: null } });
    }),
  );
  return urls;
}

function erasePost(cookie?: string): Request {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (cookie) headers.set("Cookie", cookie);
  return new Request("https://pivotparlor.com/dev/activity", {
    method: "POST",
    headers,
    body: new URLSearchParams({ intent: "erase", user_id: "u-2" }),
  });
}

function pageGet(cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return new Request("https://pivotparlor.com/dev/activity.data?_routes=routes%2Fdev.activity", { headers });
}

const run = {
  action: (req: Request) => action({ request: req, context, params: {} } as never),
  loader: (req: Request) => loader({ request: req, context, params: {} } as never),
};

/** The redirect the handler threw; fails the test if it returned instead. */
async function thrownRedirect(p: Promise<unknown>): Promise<Response> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  throw new Error("the handler returned normally instead of refusing");
}

const ERASE_URL = `${API_URL}/api/audit/subjects/u-2/erase`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dev.activity action (erase)", () => {
  it.each([
    ["customer", "/account"],
    ["admin", "/admin"],
    ["staff", "/staff"],
  ])("refuses role %s and never calls erase", async (role, home) => {
    const urls = stubApi(role);
    const res = await thrownRedirect(run.action(erasePost(SESSION)));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(home);
    expect(urls).not.toContain(ERASE_URL);
  });

  it("sends a request with no session to sign in, without calling the API", async () => {
    const urls = stubApi("developer");
    const res = await thrownRedirect(run.action(erasePost()));
    expect(res.headers.get("Location")).toBe("/login?redirect=%2Fdev%2Factivity");
    expect(urls).toEqual([]);
  });

  it("sends a session the API refuses to sign in, without calling erase", async () => {
    const urls = stubApi(null);
    const res = await thrownRedirect(run.action(erasePost(SESSION)));
    // Same destination as no session at all: sign in, then back to this page.
    expect(res.headers.get("Location")).toBe("/login?redirect=%2Fdev%2Factivity");
    expect(urls).not.toContain(ERASE_URL);
  });

  it("lets a developer erase (control)", async () => {
    const urls = stubApi("developer");
    const res = asResponse(await run.action(erasePost(SESSION)));
    expect(res.status).toBe(200);
    expect(urls.filter((u) => u === ERASE_URL)).toHaveLength(1);
  });
});

describe("dev.activity loader", () => {
  it("refuses a customer and never reads the audit log", async () => {
    const urls = stubApi("customer");
    const res = await thrownRedirect(run.loader(pageGet(SESSION)));
    expect(res.headers.get("Location")).toBe("/account");
    expect(urls.some((u) => u.startsWith(`${API_URL}/api/audit`))).toBe(false);
  });

  it("lets a developer read the audit log (control)", async () => {
    const urls = stubApi("developer");
    const res = asResponse(await run.loader(pageGet(SESSION)));
    expect(res.status).toBe(200);
    expect(urls.some((u) => u.startsWith(`${API_URL}/api/audit`))).toBe(true);
  });
});
