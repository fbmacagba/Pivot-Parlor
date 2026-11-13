/** Form actions read their body with request.formData(), which throws when the
 *  body is not a form: JSON, plain text, a broken multipart body, or no body.
 *  A thrown error is a 500 on the site and an error alert to the owner, and the
 *  public forms (login, contact, booking, waitlist, invite) can be sent one by
 *  anyone. Each action must answer such a request with a 400 and call no API.
 *  Lives in lib/ rather than routes/ so Remix never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the actions run here. The page modules' UI imports are stubbed (as
// staffViewForDeveloper.test.ts does): those packages resolve react from the
// root node_modules, where it is not installed.
vi.mock("@remix-run/react", () => {
  const Stub = () => null;
  return {
    Await: Stub,
    Form: Stub,
    Link: Stub,
    NavLink: Stub,
    Outlet: Stub,
    isRouteErrorResponse: () => false,
    useActionData: () => undefined,
    useFetcher: () => ({ state: "idle", submit: () => undefined }),
    useLoaderData: () => ({}),
    useLocation: () => ({ pathname: "/", search: "" }),
    useNavigate: () => () => undefined,
    useNavigation: () => ({ state: "idle" }),
    useParams: () => ({}),
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useRouteError: () => null,
    useRouteLoaderData: () => undefined,
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
// Radix pulls in react-remove-scroll, which resolves react from the root too.
// (vi.mock is hoisted, so each factory is written out in place.)
vi.mock(
  "@radix-ui/react-dialog",
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

import * as contact from "~/routes/_marketing.contact";
import * as login from "~/routes/login";
import * as invite from "~/routes/invite.$token";
import * as shopWaitlist from "~/routes/$shopSlug.waitlist";
import * as shopBook from "~/routes/$shopSlug.book";
import * as adminBookings from "~/routes/admin.bookings";
import * as adminInventory from "~/routes/admin.inventory";
import * as adminPos from "~/routes/admin.pos";
import * as adminProducts from "~/routes/admin.products";
import * as adminQueue from "~/routes/admin.queue";
import * as adminSales from "~/routes/admin.sales";
import * as adminServices from "~/routes/admin.services";
import * as adminStaff from "~/routes/admin.staff";
import * as adminWaitlist from "~/routes/admin.waitlist";
import * as staffPos from "~/routes/staff.pos";
import * as devActivity from "~/routes/dev.activity";
import * as devEnquiries from "~/routes/dev.enquiries";
import * as devShops from "~/routes/dev.shops._index";
import * as setupTemplate from "~/routes/setup.template-select";
import * as siteCandidate from "~/routes/api.shops.$shopId.site-candidate";
import * as serviceProducts from "~/routes/api.shops.$shopId.services.$serviceId.products";
import * as generateSite from "~/routes/api.shops.$shopId.generate-site";
import * as generateImage from "~/routes/api.shops.$shopId.generate-image";
import * as staffAvatar from "~/routes/api.staff.$shopId.$staffId.avatar";

type Role = "admin" | "staff" | "developer";
type ActionModule = { action: (args: never) => Promise<unknown> };

const API_URL = "https://api.test";
const context = { env: { API_URL } };
const params = { shopSlug: "fade-and-blade", token: "tok-1", shopId: "shop-1", staffId: "staff-1", serviceId: "svc-1" };

let calls: string[] = [];

/** Stubs the API: /auth/me answers as `role` of shop-1; every other call is recorded and answers 200. */
function stubApi(role: Role) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/auth/me") {
        return Response.json({ success: true, data: { id: "u-1", role, shop_id: "shop-1" } });
      }
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return Response.json({ success: true, data: {} });
    }),
  );
}

// Not a form: JSON, plain text, a multipart body that does not parse, and no body at all.
const NOT_A_FORM: Array<[string, Record<string, string>, string | null]> = [
  ["JSON", { "Content-Type": "application/json" }, '{"email":"a@b.test"}'],
  ["plain text", { "Content-Type": "text/plain" }, "hello"],
  ["broken multipart", { "Content-Type": "multipart/form-data; boundary=zzz" }, "not multipart at all"],
  ["no body", {}, null],
];

const ACTIONS: Array<[string, unknown, Role]> = [
  ["_marketing.contact", contact, "admin"],
  ["login", login, "admin"],
  ["invite.$token", invite, "admin"],
  ["$shopSlug.waitlist", shopWaitlist, "admin"],
  ["$shopSlug.book", shopBook, "admin"],
  ["admin.bookings", adminBookings, "admin"],
  ["admin.inventory", adminInventory, "admin"],
  ["admin.pos", adminPos, "admin"],
  ["admin.products", adminProducts, "admin"],
  ["admin.queue", adminQueue, "admin"],
  ["admin.sales", adminSales, "admin"],
  ["admin.services", adminServices, "admin"],
  ["admin.staff", adminStaff, "admin"],
  ["admin.waitlist", adminWaitlist, "admin"],
  ["staff.pos", staffPos, "staff"],
  ["dev.activity", devActivity, "developer"],
  ["dev.enquiries", devEnquiries, "developer"],
  ["dev.shops._index", devShops, "developer"],
  ["setup.template-select", setupTemplate, "admin"],
  ["api.shops.$shopId.site-candidate", siteCandidate, "developer"],
  ["api.shops.$shopId.services.$serviceId.products", serviceProducts, "admin"],
  ["api.shops.$shopId.generate-site", generateSite, "developer"],
  ["api.shops.$shopId.generate-image", generateImage, "developer"],
  ["api.staff.$shopId.$staffId.avatar", staffAvatar, "admin"],
];

/** The action's answer: what it returned or threw as a Response, or what it threw otherwise. */
async function run(mod: ActionModule, headers: Record<string, string>, body: string | null): Promise<string> {
  const request = new Request("https://pivotparlor.com/x?shopId=shop-1", {
    method: "POST",
    headers: { ...headers, Cookie: "pp_session=tok.abc.123" },
    body,
  });
  try {
    const res = (await mod.action({ request, params, context } as never)) as Response;
    return `${res.status}`;
  } catch (thrown) {
    if (thrown instanceof Response) return `${thrown.status}`;
    return `THREW ${(thrown as Error)?.name ?? typeof thrown}`;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Two routes are proxies that also take JSON on purpose, so a body that is not
 * a form is not a mistake there:
 * - generate-site proxies JSON (and plain or empty bodies) to the API as it is;
 *   only a body that claims to be multipart and is not must be refused.
 * - generate-image forwards whatever it can read, and {} for anything it
 *   cannot, and leaves validation to the API (which answers a bad body with a
 *   400 of its own). It must never throw.
 * The stubbed API answers 200, so "200 calls ..." means "passed on, did not throw".
 */
function expectedAnswer(name: string, kind: string): string {
  if (name === "api.shops.$shopId.generate-site" && kind !== "broken multipart") {
    return "200 calls POST /api/shops/shop-1/generate-site";
  }
  if (name === "api.shops.$shopId.generate-image") return "200 calls POST /api/shops/shop-1/generate-image";
  return "400";
}

describe("a form action sent a body that is not a form", () => {
  it("answers 400 and calls no API, for every form action and every kind of non-form body", async () => {
    const seen: string[] = [];
    const expected: string[] = [];
    for (const [name, mod, role] of ACTIONS) {
      for (const [kind, headers, body] of NOT_A_FORM) {
        stubApi(role);
        const answer = await run(mod as ActionModule, headers, body);
        seen.push(`${name} / ${kind} -> ${answer}${calls.length ? ` calls ${calls.join(", ")}` : ""}`);
        expected.push(`${name} / ${kind} -> ${expectedAnswer(name, kind)}`);
      }
    }
    expect(seen).toEqual(expected);
  });

  it("still reads a real form (control: login gets past the body to its own field check)", async () => {
    stubApi("admin");
    const form = new URLSearchParams({ email: "", password: "" });
    const answer = await run(
      login as ActionModule,
      { "Content-Type": "application/x-www-form-urlencoded" },
      form.toString(),
    );
    expect(answer).toBe("400");
    const res = (await (login as ActionModule).action({
      request: new Request("https://pivotparlor.com/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context,
    } as never)) as Response;
    expect(await res.json()).toEqual({ error: "Email and password are required." });
  });
});

// ─── Source guard ─────────────────────────────────────────────────────────────
// Every form body is read through readFormData (app/lib/formBody.ts), which
// answers a non-form body with null instead of throwing. This covers every
// route and lib, including ones added later.

const sources = import.meta.glob(["../routes/**/*.{ts,tsx}", "./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RAW_FORM_READ = /\brequest\s*\.\s*formData\s*\(/g;

function rawReads(text: string): number {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return code.match(RAW_FORM_READ)?.length ?? 0;
}

describe("form body source", () => {
  it("the check finds the raw reads it exists to forbid (control)", () => {
    expect(rawReads("const form = await request.formData();")).toBe(1);
    expect(rawReads("const form = await request\n    .formData();")).toBe(1);
    expect(rawReads("// request.formData() used to throw here")).toBe(0);
    expect(rawReads("const form = await readFormData(request);")).toBe(0);
  });

  it("no route or lib reads a request body with a raw request.formData(), except readFormData itself", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(100);
    const found = files
      .filter((f) => !f.endsWith("/formBody.ts") && rawReads(sources[f]!) > 0)
      .map((f) => `${f} x${rawReads(sources[f]!)}`)
      .sort();
    expect(found).toEqual([]);
  });
});
