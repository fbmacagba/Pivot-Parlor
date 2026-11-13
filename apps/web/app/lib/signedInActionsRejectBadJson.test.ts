/** Signed-in actions that read a JSON body. A body that is not a JSON object
 *  is the caller's mistake: it gets a 400 and never reaches the API, instead
 *  of throwing (a 500 on the site, and an error alert to the owner). Routes
 *  whose body is optional pass it on as an empty object. Lives in lib/ rather
 *  than routes/ so Remix never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the actions run here. The page modules' UI imports are stubbed (as
// staffViewForDeveloper.test.ts does): those packages resolve react from the
// root node_modules, where it is not installed.
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
    useNavigation: () => ({ state: "idle" }),
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useRouteError: () => null,
    useSearchParams: () => [new URLSearchParams(), () => undefined],
    useSubmit: () => () => undefined,
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

import * as adminSchedule from "~/routes/admin.schedule";
import * as adminSettings from "~/routes/admin.settings";
import * as staffBookings from "~/routes/staff.bookings";
import * as meProfile from "~/routes/api.me.profile";
import * as meBookings from "~/routes/api.me.bookings";
import * as generateSite from "~/routes/api.shops.$shopId.generate-site";

const API_URL = "https://api.test";
const context = { env: { API_URL } };

type Call = { method: string; path: string; body: string | null };
let calls: Call[] = [];

/** Stubs the API: /auth/me answers as `role` of shop-1; anything else answers 200. */
function stubApi(role: "admin" | "staff" | "customer") {
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
        path: url.pathname,
        body: typeof init?.body === "string" ? init.body : null,
      });
      return Response.json({ success: true, data: {} });
    }),
  );
}

function post(body: string): Request {
  return new Request("https://pivotparlor.com/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "pp_session=tok.abc.123" },
    body,
  });
}

type ActionModule = { action: (args: never) => Promise<unknown> };

async function run(mod: ActionModule, request: Request): Promise<Response> {
  try {
    return (await mod.action({ request, params: { shopId: "shop-1" }, context } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const MALFORMED = ["this is not json {", "", "null", "[]", "42", '"text"'];

const REQUIRED: Array<[string, ActionModule, "admin" | "staff" | "customer", unknown]> = [
  ["admin.schedule", adminSchedule as ActionModule, "admin", { entries: [] }],
  ["admin.settings", adminSettings as ActionModule, "admin", { booking_lead_hours: 2 }],
  ["staff.bookings", staffBookings as ActionModule, "staff", { from_date: "2099-01-01", to_date: "2099-01-02" }],
  ["api.me.profile", meProfile as ActionModule, "customer", { name: "Casey" }],
];

describe("signed-in actions that need a JSON body", () => {
  for (const [name, mod, role, valid] of REQUIRED) {
    it.each(MALFORMED)(`${name} answers %j with 400 'Invalid JSON' and calls no API`, async (raw) => {
      stubApi(role);
      const res = await run(mod, post(raw));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe("Invalid JSON");
      expect(calls).toEqual([]);
    });

    it(`${name} still sends a real body to the API (control)`, async () => {
      stubApi(role);
      const res = await run(mod, post(JSON.stringify(valid)));
      expect(res.status).toBeLessThan(400);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!.body ?? "null")).toEqual(valid);
    });
  }
});

describe("signed-in actions whose JSON body is optional", () => {
  it.each(MALFORMED)("api.me.bookings answers %j with its own 400 and calls no API", async (raw) => {
    stubApi("customer");
    const res = await run(meBookings as ActionModule, post(raw));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "Invalid request" });
    expect(calls).toEqual([]);
  });

  it.each(MALFORMED)("generate-site passes %j on as an empty object", async (raw) => {
    stubApi("admin");
    const res = await run(generateSite as ActionModule, post(raw));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "POST", path: "/api/shops/shop-1/generate-site", body: "{}" }]);
  });

  it("generate-site still passes a real body on (control)", async () => {
    stubApi("admin");
    await run(generateSite as ActionModule, post(JSON.stringify({ template: "classic" })));
    expect(calls.map((c) => c.body)).toEqual([JSON.stringify({ template: "classic" })]);
  });
});

// ─── Source guard ─────────────────────────────────────────────────────────────
// An action whose body is read raw lets a malformed body throw. This covers
// every route, including ones added later.

const routeSources = import.meta.glob("../routes/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RAW_REQUEST_JSON = /\brequest\s*\.\s*json\s*\(/g;

function rawReads(text: string): number {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return code.match(RAW_REQUEST_JSON)?.length ?? 0;
}

describe("route source", () => {
  it("the check finds the raw reads it exists to forbid (control)", () => {
    expect(rawReads("const body = await request.json();")).toBe(1);
    expect(rawReads("const body = (await request.json().catch(() => ({}))) as X;")).toBe(1);
    expect(rawReads("const body = await request\n    .json();")).toBe(1);
    expect(rawReads("// request.json() used to throw here")).toBe(0);
    expect(rawReads("const data = await res.json();")).toBe(0);
    expect(rawReads("const body = await readJsonObject(request);")).toBe(0);
  });

  it("no route reads a request body with a raw request.json()", () => {
    const files = Object.keys(routeSources);
    expect(files.length).toBeGreaterThan(80);
    const found = files
      .filter((f) => rawReads(routeSources[f]!) > 0)
      .map((f) => `${f.replace("../routes/", "")} x${rawReads(routeSources[f]!)}`)
      .sort();
    expect(found).toEqual([]);
  });
});
